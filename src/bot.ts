import fs from "node:fs";
import ytdl from "@distube/ytdl-core";
import { PrismaClient } from "@prisma/client";
import axios from "axios";
import { config } from "dotenv";
import { Telegraf } from "telegraf";
import { parseStringPromise } from "xml2js";
import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import { summarizeDescription } from "./summarizeDescription";
import { checkAndUploadNewVideo } from "./checkAndUploadNewVideo";
import { Markup } from "telegraf";
import OpenAI from "openai";
config();

const prisma = new PrismaClient();
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_BOT_TOKEN) {
	throw new Error("TELEGRAM_BOT_TOKEN is not set");
}
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const FIRESHIP_CHANNEL_ID = "UCsBjURrPoezykLs9EqgamOA";
const VIDEO_CHANNEL_ID = process.env.VIDEO_CHANNEL_ID;

interface Video {
	id: string;
	title: string;
	description: string;
	thumbnailUrl: string;
}

// Logger configuration
export const logger = winston.createLogger({
	level: "info",
	format: winston.format.combine(
		winston.format.timestamp(),
		winston.format.errors({ stack: true }),
		winston.format.splat(),
		winston.format.printf(({ level, message, timestamp, ...metadata }) => {
			let msg = `${timestamp} [${level}]: ${message}`;
			if (Object.keys(metadata).length > 0) {
				msg += ` ${JSON.stringify(metadata)}`;
			}
			return msg;
		}),
	),
	defaultMeta: { service: "telegram-bot" },
	transports: [
		new winston.transports.Console({
			format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
		}),
		new DailyRotateFile({
			filename: "logs/application-%DATE%.log",
			datePattern: "YYYY-MM-DD",
			zippedArchive: true,
			maxSize: "20m",
			maxFiles: "14d",
		}),
	],
});

export async function getLatestFireshipVideo(): Promise<Video | null> {
	logger.info("Fetching latest Fireship video");

	try {
		const response = await axios.get(
			`https://www.youtube.com/feeds/videos.xml?channel_id=${FIRESHIP_CHANNEL_ID}`,
		);
		const result = await parseStringPromise(response.data);
		const latestVideo = result.feed.entry[0];

		if (!latestVideo) return null;

		logger.info("Successfully fetched latest Fireship video", {
			videoId: latestVideo["yt:videoId"][0],
		});
		return {
			id: latestVideo["yt:videoId"][0],
			title: latestVideo.title[0],
			description: latestVideo["media:group"][0]["media:description"][0],
			thumbnailUrl: `https://i.ytimg.com/vi/${latestVideo["yt:videoId"][0]}/hqdefault.jpg`,
		};
	} catch (error) {
		logger.error("Error fetching latest Fireship video", { error });
		return null;
	}
}

export async function downloadVideo(videoId: string): Promise<string> {
	logger.info("Starting video download", { videoId });
	const outputPath = `./temp_${videoId}.mp4`;

	return new Promise((resolve, reject) => {
		let downloadedBytes = 0;
		let totalBytes = 0;
		const url = `https://www.youtube.com/watch?v=${videoId}`;
		logger.info("URL:", url);
		const stream = ytdl(url, {
			quality: "highestvideo",
			filter: "videoandaudio",
		})
			.on("progress", (_, downloaded, total) => {
				downloadedBytes = downloaded;
				if (total > totalBytes) {
					totalBytes = total;
				}
				const progress = ((downloadedBytes / totalBytes) * 100).toFixed(2);
				logger.info(`Downloading: ${progress}% (${downloadedBytes}/${totalBytes} bytes)`);
			})
			.pipe(fs.createWriteStream(outputPath));

		stream.on("finish", () => {
			logger.info("Video download completed", { videoId, outputPath });
			resolve(outputPath);
		});
		stream.on("error", (error) => {
			logger.error("Video download error", { videoId, error });
			reject(error);
		});
	});
}

export async function uploadVideoToTelegram(video: Video): Promise<number> {
	logger.info("Starting video upload to Telegram", { videoId: video.id });
	try {
		const descriptionSummary = await summarizeDescription(video.description);
		const message = await bot.telegram.sendMessage(
			VIDEO_CHANNEL_ID as string,
			`${video.title}\n\n${descriptionSummary}\n\nhttps://www.youtube.com/watch?v=${video.id}`,
			{
				parse_mode: "HTML",
			},
		);

		await setLastUploadedVideoId(video.id, video.title);

		return message.message_id;
	} catch (error) {
		logger.error("Error uploading video to Telegram", { error });
		throw error;
	}
}

// Update these functions to use Prisma
export async function getLastUploadedVideoId(): Promise<string> {
	const lastVideo = await prisma.uploadedVideo.findFirst({
		orderBy: { uploadedAt: "desc" },
	});
	return lastVideo?.id ?? "";
}

export async function setLastUploadedVideoId(videoId: string, title: string): Promise<void> {
	await prisma.uploadedVideo.upsert({
		where: { id: videoId },
		update: { uploadedAt: new Date(), title },
		create: { id: videoId, title },
	});
}

// Add this function to fetch the last 5 videos
async function getLastFiveVideos(): Promise<{ id: string; title: string }[]> {
	try {
		const videos = await prisma.uploadedVideo.findMany({
			take: 5,
			orderBy: { uploadedAt: "desc" },
			select: { id: true, title: true },
		});
		return videos;
	} catch (error) {
		logger.error("Error fetching last five videos", { error });
		throw error;
	}
}

// Add this function to delete a video
async function deleteVideo(videoId: string): Promise<void> {
	try {
		await prisma.uploadedVideo.delete({
			where: { id: videoId },
		});
		logger.info("Video deleted successfully", { videoId });
	} catch (error) {
		logger.error("Error deleting video", { videoId, error });
		throw error;
	}
}

// Add these command handlers
bot.command("list", async (ctx) => {
	try {
		const videos = await getLastFiveVideos();
		if (videos.length === 0) {
			await ctx.reply("No videos have been uploaded yet.");
			return;
		}

		const message = videos
			.map((video, index) => `${index + 1}. ${video.title || video.id}`)
			.join("\n");

		const keyboard = Markup.inlineKeyboard(
			videos.map((video, index) =>
				Markup.button.callback(`Delete ${index + 1}`, `delete:${video.id}`),
			),
		);

		await ctx.reply(message, keyboard);
	} catch (error) {
		logger.error("Error handling /list command", { error });
		await ctx.reply("An error occurred while fetching the video list.");
	}
});

bot.action(/^delete:(.+)$/, async (ctx) => {
	if (!ctx.match) return;
	const videoId = ctx.match[1];
	try {
		await deleteVideo(videoId);
		await ctx.answerCbQuery(`Video ${videoId} has been deleted.`);
	} catch (error) {
		logger.error("Error handling delete action", { videoId, error });
		await ctx.answerCbQuery("An error occurred while deleting the video.", { show_alert: true });
	}
});

// Update the main function to initialize Prisma
async function main() {
	try {
		logger.info("Starting bot");
		await prisma.$connect();
		logger.info("Database connection successful");
		bot.launch();
		logger.info("Bot is running");
		setInterval(checkAndUploadNewVideo, 60 * 60 * 1000); // Check every hour
		logger.info("Interval set for checking new videos");
		logger.info("Starting the bot...");
		await checkAndUploadNewVideo();
	} catch (error) {
		logger.error("Error starting bot", { error });
		console.error("Error starting bot:", error);
	}
}

// Run the main function
main().catch((error) => {
	logger.error("Unhandled error in main function", { error });
});

// Enable graceful stop
process.once("SIGINT", async () => {
	bot.stop("SIGINT");
	await prisma.$disconnect();
});
process.once("SIGTERM", async () => {
	bot.stop("SIGTERM");
	await prisma.$disconnect();
});

declare global {
	interface String {
		capitalize(): string;
	}
}

String.prototype.capitalize = function () {
	return this.charAt(0).toUpperCase() + this.slice(1);
};
