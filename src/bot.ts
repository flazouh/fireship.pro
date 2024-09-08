import fs from "node:fs";
import ytdl from "@distube/ytdl-core";
import { PrismaClient } from "@prisma/client";
import axios, { AxiosProxyConfig } from "axios";
import { load } from "cheerio";
import { config } from "dotenv";
import ffmpeg from "fluent-ffmpeg";
import OpenAI from "openai";
import { Telegraf } from "telegraf";
import { parseStringPromise } from "xml2js";
import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import { cleanSubtitleText } from "./cleanSubtitleText";
import { formatTime } from "./formatTime";
import { summarizeDescription } from "./summarizeDescription";
import { HttpsProxyAgent } from "https-proxy-agent";
import { checkAndUploadNewVideo } from "./checkAndUploadNewVideo";
import { Markup } from "telegraf";
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

function getProxyAgent(): HttpsProxyAgent<string> | null {
	const proxyUrl = process.env.PROXY_URL;
	if (!proxyUrl) {
		logger.error("Proxy URL is not set");
		return null;
	}
	return new HttpsProxyAgent(proxyUrl);
}

export async function getLatestFireshipVideo(): Promise<Video | null> {
	logger.info("Fetching latest Fireship video");

	try {
		const response = await axios.get(
			`https://www.youtube.com/feeds/videos.xml?channel_id=${FIRESHIP_CHANNEL_ID}`,
			{ httpsAgent: getProxyAgent() },
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
	logger.info("Downloading video:", videoId);
	const outputPath = `./temp_${videoId}.mp4`;

	return new Promise((resolve, reject) => {
		let downloadedBytes = 0;
		let totalBytes = 0;
		const proxyURL = process.env.PROXY_URL;
		if (!proxyURL) {
			logger.error("Proxy URL is not set");
			reject(new Error("Proxy URL is not set"));
			return;
		}
		// agent should be created once if you don't want to change your cookie
		const ytdlAgent = ytdl.createProxyAgent({ uri: proxyURL });
		const url = `https://www.youtube.com/watch?v=${videoId}`;
		logger.info("URL:", url);
		const stream = ytdl(url, {
			quality: "highestvideo",
			filter: "videoandaudio",
			agent: ytdlAgent,
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
			logger.info("Download completed");
			resolve(outputPath);
		});
		stream.on("error", (error) => {
			logger.error("Video download error", { videoId, error });
			console.error("Download error:", error);
			reject(error);
		});
	});
}
export interface Subtitle {
	text: string;
	startTime: number;
	endTime: number;
}
export async function uploadVideoToTelegram(
	videoPath: string,
	video: Video,
	subtitles: Subtitle[],
): Promise<number> {
	logger.info("Starting video upload to Telegram", { videoTitle: video.title });
	try {
		logger.info("Video path:", videoPath);

		const videoFile = { source: videoPath };
		logger.info(`Uploading video to Telegram: ${video.title}`);

		const descriptionSummary = await summarizeDescription(subtitles, video.description);
		const message = await bot.telegram.sendVideo(VIDEO_CHANNEL_ID as string, videoFile, {
			caption: `🎉 New Fireship video: \n\n${video.title}\n\n${descriptionSummary}`,
		});

		// Save the video with its title
		await setLastUploadedVideoId(video.id, video.title);

		logger.info("Video successfully uploaded to Telegram", { messageId: message.message_id });
		logger.info("Video uploaded to Telegram:", message);
		logger.info("Deleting temporary video file:", videoPath);
		fs.unlinkSync(videoPath); // Delete the temporary video file
		return message.message_id;
	} catch (error) {
		logger.error("Error uploading video to Telegram", { error });
		console.error("Error uploading video to Telegram:", error);
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
export async function getSubtitles(id: string): Promise<Subtitle[]> {
	logger.info("Fetching subtitles", { videoId: id });

	try {
		const proxyURL = process.env.PROXY_URL;
		if (!proxyURL) {
			logger.error("Proxy URL is not set");
			throw new Error("Proxy URL is not set");
		}
		const proxyConfig = {
			host: proxyURL.split(":")[0],
			port: Number.parseInt(proxyURL.split(":")[1]),
		} satisfies AxiosProxyConfig;
		const response = await axios.get(`https://www.youtube.com/watch?v=${id}`, {
			proxy: proxyConfig,
			timeout: 10000,
		});
		if (!response.data) throw new Error("Failed to fetch video");
		if (typeof response.data !== "string") throw new Error("Invalid response data");
		if (response.status !== 200) throw new Error("Failed to fetch video");
		const html = response.data;
		// Extract the ytInitialPlayerResponse from the HTML
		const match = html.match(/ytInitialPlayerResponse\s*=\s*({.*?});/);
		if (!match) throw new Error("Failed to extract ytInitialPlayerResponse");

		const playerResponse = JSON.parse(match[1]);
		logger.info("Player response:", JSON.stringify(playerResponse, null, 2));
		const captionTracks = playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks;

		if (!captionTracks || captionTracks.length === 0) {
			logger.error(`No captions found for video ${id}: ${JSON.stringify(html)}`);
			throw new Error(`No captions found for video ${id}`);
		}

		// Prefer English captions, fallback to the first available
		const captionTrack =
			captionTracks.find((track) => track.languageCode === "en") || captionTracks[0];

		const subtitlesResponse = await axios.get(captionTrack.baseUrl, {
			proxy: proxyConfig,
		});
		const subtitlesXml = subtitlesResponse.data;

		// Parse XML and extract text using cheerio
		const $ = load(subtitlesXml, { xmlMode: true });
		const textNodes = $("text");

		const subtitles = textNodes
			.map((i, node) => {
				const text = cleanSubtitleText($(node).text()).capitalize();
				const startString = $(node).attr("start") || "0";
				const durationString = $(node).attr("dur") || "0";
				logger.info("Subtitle:", text, startString, durationString);
				const startTime = Number.parseFloat(startString);
				const endTime = startTime + Number.parseFloat(durationString);
				if (!startTime || !endTime) return null;
				return { text, startTime, endTime };
			})
			.get();
		logger.info("Subtitles fetched successfully", { videoId: id, subtitleCount: subtitles.length });
		logger.info(subtitles);
		return subtitles.filter((subtitle) => subtitle !== null);
	} catch (error) {
		logger.error("Error fetching subtitles", { videoId: id, error });
		console.error("Error fetching subtitles:", error);
		throw error;
	}
}

export async function addSubtitlesToVideo(
	videoPath: string,
	translatedSubs: Subtitle[] | null,
): Promise<string> {
	logger.info("Adding subtitles to video", { videoPath });
	// Generate a temporary SRT file from translatedSubs
	if (!translatedSubs) return videoPath;
	const srtContent = translatedSubs
		.map((sub, index) => {
			const startTime = formatTime(sub.startTime);
			const endTime = formatTime(sub.endTime);
			return `${index + 1}\n${startTime} --> ${endTime}\n${sub.text}\n\n`;
		})
		.join("");

	const tempSrtPath = `temp_${Date.now()}.srt`;
	await fs.promises.writeFile(tempSrtPath, srtContent);

	// Generate output video path
	const outputPath = `output_${Date.now()}.mp4`;

	try {
		// Use ffmpeg to add subtitles to the video
		await new Promise<void>((resolve, reject) => {
			ffmpeg(videoPath)
				.outputOptions("-vf", `subtitles=${tempSrtPath}:force_style='FontSize=24'`)
				.output(outputPath)
				.on("end", () => resolve())
				.on("error", (err) => reject(err))
				.run();
		});

		// Update video object with new file path
		const updatedVideo: string = outputPath;

		// Clean up temporary SRT file
		await fs.promises.unlink(tempSrtPath);

		logger.info("Subtitles added successfully", { outputPath });
		return updatedVideo;
	} catch (error) {
		logger.error("Error adding subtitles to video", { videoPath, error });
		console.error("Error adding subtitles to video:", error);
		throw error;
	}
}
