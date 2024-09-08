import { PrismaClient } from "@prisma/client";
import axios from "axios";
import { load } from "cheerio";
import { config } from "dotenv";
import OpenAI from "openai";
import { Telegraf } from "telegraf";
import { parseStringPromise } from "xml2js";
import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import { cleanSubtitleText } from "./cleanSubtitleText";

config();

const prisma = new PrismaClient();
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_BOT_TOKEN) {
	throw new Error("TELEGRAM_BOT_TOKEN is not set");
}
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const FIRESHIP_CHANNEL_ID = "UCsBjURrPoezykLs9EqgamOA";
const VIDEO_CHANNEL_ID = process.env.VIDEO_CHANNEL_ID;
if (!VIDEO_CHANNEL_ID) {
	throw new Error("VIDEO_CHANNEL_ID is not set");
}

interface Video {
	id: string;
	title: string;
	description: string;
	thumbnailUrl: string;
}

// Logger configuration
const logger = winston.createLogger({
	level: "info",
	format: winston.format.combine(
		winston.format.timestamp(),
		winston.format.errors({ stack: true }),
		winston.format.splat(),
		winston.format.printf(({ level, message, timestamp }) => {
			const msg = `${timestamp} [${level}]: ${message}`;
			return msg;
		}),
	),
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

async function getLatestFireshipVideo(): Promise<Video | null> {
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

async function translateSubs(subtitles: Subtitle[], language: string): Promise<Subtitle[]> {
	logger.info("Starting subtitle translation", { language, subtitleCount: subtitles.length });
	if (!subtitles) return subtitles;
	for (const subtitle of subtitles.slice(0, 5)) {
		logger.info("Translating subtitle:", subtitle.text);
		try {
			const completion = await openai.chat.completions.create({
				model: "gpt-4-turbo-preview", // Use an appropriate model
				messages: [
					{
						role: "system",
						content: JSON.stringify({
							role: "AI assistant",
							task: "Translate and improve subtitles",
							instructions: `Provide only the translation to ${language} without any additional content in JSON format ({"translation": "..."})`,
						}),
					},
					{
						role: "user",
						content: JSON.stringify({
							action: "translate",
							target_language: language,
							text: subtitle.text,
							instructions: `Provide only the translation to ${language} without any additional content`,
						}),
					},
				],
				response_format: { type: "json_object" },
			});
			logger.info("Translation:", completion.choices[0].message.content);
			const translation = JSON.parse(completion.choices[0].message.content || "{}");
			subtitle.text = translation.translation || subtitle.text;
		} catch (error) {
			console.error("Error translating subtitle:", error);
			// Keep original text if translation fails
		}
	}
	return subtitles;
}

interface Subtitle {
	text: string;
	startTime: number;
	endTime: number;
}

async function uploadVideoToTelegram(video: Video, subtitles: Subtitle[]): Promise<number> {
	logger.info("Sending video link to Telegram", { videoTitle: video.title });
	try {
		const descriptionSummary = await summarizeDescription(subtitles, video.description);
		const videoUrl = `https://www.youtube.com/watch?v=${video.id}`;
		const message = await bot.telegram.sendMessage(
			VIDEO_CHANNEL_ID as string,
			`🎉 New Fireship video: \n\n${video.title}\n\n${descriptionSummary}\n\n${videoUrl}`,
			{ parse_mode: "HTML" },
		);

		logger.info("Video link successfully sent to Telegram", { messageId: message.message_id });
		return message.message_id;
	} catch (error) {
		logger.error("Error sending video link to Telegram", { error });
		throw error;
	}
}

function getFixedSubtitles(subtitles: Subtitle[] | null): Subtitle[] {
	if (!subtitles) return [];
	// Sort subtitles by start time to ensure proper order
	const sortedSubtitles = [...subtitles].sort((a, b) => a.startTime - b.startTime);
	const fixedSubtitles: Subtitle[] = [];

	for (let i = 0; i < sortedSubtitles.length - 1; i++) {
		const current = sortedSubtitles[i];
		const next = sortedSubtitles[i + 1];

		// Put the end of the first subtitle at the beginning of the second
		const adjustedEndTime = next.startTime;

		fixedSubtitles.push({
			...current,
			endTime: adjustedEndTime,
		});
	}

	// Add the last subtitle without modification
	fixedSubtitles.push(sortedSubtitles[sortedSubtitles.length - 1]);

	return fixedSubtitles;
}

async function checkAndUploadNewVideo(): Promise<void> {
	logger.info("Checking for new videos");
	const video = await getLatestFireshipVideo();
	if (!video) {
		logger.error("No video found");
		return;
	}

	const lastUploadedVideoId = await getLastUploadedVideoId();
	if (video.id === lastUploadedVideoId) {
		logger.info("No new videos found");
		return;
	}

	const subtitles = await getSubtitles(video.id);
	await uploadVideoToTelegram(video, subtitles);
	await setLastUploadedVideoId(video.id);
	logger.info("Video link sent successfully", { videoId: video.id });
}

// Update these functions to use Prisma
async function getLastUploadedVideoId(): Promise<string> {
	const lastVideo = await prisma.uploadedVideo.findFirst({
		orderBy: { uploadedAt: "desc" },
	});
	return lastVideo?.id ?? "";
}

async function setLastUploadedVideoId(videoId: string): Promise<void> {
	await prisma.uploadedVideo.upsert({
		where: { id: videoId },
		update: { uploadedAt: new Date() },
		create: { id: videoId },
	});
}

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

async function getSubtitles(id: string): Promise<Subtitle[]> {
	logger.info("Fetching subtitles", { videoId: id });
	try {
		const response = await axios.get(`https://www.youtube.com/watch?v=${id}`);
		if (!response.data) throw new Error("Failed to fetch video");
		if (typeof response.data !== "string") throw new Error("Invalid response data");
		if (response.status !== 200) throw new Error("Failed to fetch video");
		const html = response.data;
		logger.info("HTML:", html);
		// Extract the ytInitialPlayerResponse from the HTML
		const match = html.match(/ytInitialPlayerResponse\s*=\s*({.*?});/);
		logger.info("Match:", match);
		if (!match) throw new Error("Failed to extract ytInitialPlayerResponse");

		const playerResponse = JSON.parse(match[1]);
		logger.info("Player response:", JSON.stringify(playerResponse, null, 2));
		const captionTracks = playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks;

		if (!captionTracks || captionTracks.length === 0) {
			logger.error(`No captions found for video ${id}: ${JSON.stringify(html)}`);
			return [];
		}

		// Prefer English captions, fallback to the first available
		const captionTrack =
			captionTracks.find((track) => track.languageCode === "en") || captionTracks[0];

		const subtitlesResponse = await axios.get(captionTrack.baseUrl);
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
		return [];
	}
}

async function summarizeDescription(subtitles: Subtitle[], description: string): Promise<string> {
	logger.info("Summarizing video description");
	const content = `
  Description: ${description}
  Subtitles: ${subtitles.map((sub) => sub.text).join(" ")}
  `;
	const completion = await openai.chat.completions.create({
		model: "gpt-4o-mini", // Use an appropriate model
		messages: [
			{
				role: "system",
				content: JSON.stringify({
					role: "AI assistant",
					task: "Summarize the description",
					instructions: `Provide only the summary of the description in JSON format ({"summary": "..."}) without any additional content, start with "Summary: "`,
				}),
			},
			{
				role: "user",
				content: content,
			},
		],
		response_format: { type: "json_object" },
	});
	logger.info("Description summarized successfully", {
		summary: completion.choices[0].message.content,
	});
	logger.info("Summary:", completion.choices[0].message.content);
	const summary = JSON.parse(completion.choices[0].message.content || "{}");
	return summary.summary || "";
}
