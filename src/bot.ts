import fs from "node:fs";
import ytdl from "@distube/ytdl-core";
import { PrismaClient } from "@prisma/client";
import axios from "axios";
import { load } from "cheerio";
import { config } from "dotenv";
import ffmpeg from "fluent-ffmpeg";
import OpenAI from "openai";
import { Telegraf } from "telegraf";
import { parseStringPromise } from "xml2js";
import { JSDOM } from "jsdom";

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

interface Video {
	id: string;
	title: string;
	description: string;
	thumbnailUrl: string;
}

async function getLatestFireshipVideo(): Promise<Video | null> {
	try {
		const response = await axios.get(
			`https://www.youtube.com/feeds/videos.xml?channel_id=${FIRESHIP_CHANNEL_ID}`,
		);
		const result = await parseStringPromise(response.data);
		const latestVideo = result.feed.entry[0];

		if (!latestVideo) return null;

		return {
			id: latestVideo["yt:videoId"][0],
			title: latestVideo.title[0],
			description: latestVideo["media:group"][0]["media:description"][0],
			thumbnailUrl: `https://i.ytimg.com/vi/${latestVideo["yt:videoId"][0]}/hqdefault.jpg`,
		};
	} catch (error) {
		console.error("Error fetching latest Fireship video:", error);
		return null;
	}
}

async function translateSubs(subtitles: Subtitle[], language: string): Promise<Subtitle[]> {
	if (!subtitles) return subtitles;
	for (const subtitle of subtitles.slice(0, 5)) {
		console.log("Translating subtitle:", subtitle.text);
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
			console.log("Translation:", completion.choices[0].message.content);
			const translation = JSON.parse(completion.choices[0].message.content || "{}");
			subtitle.text = translation.translation || subtitle.text;
		} catch (error) {
			console.error("Error translating subtitle:", error);
			// Keep original text if translation fails
		}
	}
	return subtitles;
}

async function downloadVideo(videoId: string): Promise<string> {
	console.log("Downloading video:", videoId);
	const outputPath = `./temp_${videoId}.mp4`;
	return new Promise((resolve, reject) => {
		let downloadedBytes = 0;
		let totalBytes = 0;

		const url = `https://www.youtube.com/watch?v=${videoId}`;
		console.log("URL:", url);
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
				console.log(`Downloading: ${progress}% (${downloadedBytes}/${totalBytes} bytes)`);
			})
			.pipe(fs.createWriteStream(outputPath));

		stream.on("finish", () => {
			console.log("Download completed");
			resolve(outputPath);
		});
		stream.on("error", (error) => {
			console.error("Download error:", error);
			reject(error);
		});
	});
}
interface Subtitle {
	text: string;
	startTime: number;
	endTime: number;
}
async function uploadVideoToTelegram(videoPath: string, video: Video): Promise<number> {
	try {
		console.log("Video path:", videoPath);

		const videoFile = { source: videoPath };
		console.log(`Uploading video to Telegram: ${video.title}`);

		const descriptionSummary = await summarizeDescription(video.description);
		const message = await bot.telegram.sendVideo(VIDEO_CHANNEL_ID, videoFile, {
			caption: `${video.title}\n${descriptionSummary}`,
		});

		console.log("Video uploaded to Telegram:", message);
		console.log("Deleting temporary video file:", videoPath);
		fs.unlinkSync(videoPath); // Delete the temporary video file
		return message.message_id;
	} catch (error) {
		console.error("Error uploading video to Telegram:", error);
		throw error;
	}
}
function getFixedSubtitles(subtitles: Subtitle[]): Subtitle[] {
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
	const video = await getLatestFireshipVideo();
	if (!video) return;

	const lastUploadedVideoId = await getLastUploadedVideoId();
	if (video.id === lastUploadedVideoId) return;

	const subtitles = await getSubtitles(video.id);
	const fixedSubtitles = getFixedSubtitles(subtitles);
	// const translatedSubs = await translateSubs(fixedSubtitles, "Russian");
	const videoPath = await downloadVideo(video.id);
	const videoWithSubsPath = await addSubtitlesToVideo(videoPath, fixedSubtitles);
	await uploadVideoToTelegram(videoWithSubsPath, video);
	await setLastUploadedVideoId(video.id);
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
	await prisma.$connect();
	bot.launch();
	console.log("Bot is running");
	console.log("Database connection successful");
	setInterval(checkAndUploadNewVideo, 60 * 60 * 1000); // Check every hour
	console.log("Interval set");
	console.log("Starting the bot...");
	checkAndUploadNewVideo();
}

// Run the main function
main().catch(console.error);

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
	try {
		const response = await axios.get(`https://www.youtube.com/watch?v=${id}`);
		const html = response.data;

		// Extract the ytInitialPlayerResponse from the HTML
		const match = html.match(/ytInitialPlayerResponse\s*=\s*({.*?});/);
		if (!match) throw new Error("Failed to extract ytInitialPlayerResponse");

		const playerResponse = JSON.parse(match[1]);
		const captionTracks = playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks;

		if (!captionTracks || captionTracks.length === 0) {
			throw new Error("No captions found for this video");
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
				console.log("Subtitle:", text, startString, durationString);
				const startTime = Number.parseFloat(startString);
				const endTime = startTime + Number.parseFloat(durationString);
				if (!startTime || !endTime) return null;
				return { text, startTime, endTime };
			})
			.get();
		console.log(subtitles);
		return subtitles.filter((subtitle) => subtitle !== null);
	} catch (error) {
		console.error("Error fetching subtitles:", error);
		throw error;
	}
}

function cleanSubtitleText(text: string): string {
	const dom = new JSDOM("<!DOCTYPE html>");
	return text
		.replace(/&(#?[a-zA-Z0-9]+);/g, (match, entity) => {
			const decoded = new dom.window.DOMParser().parseFromString(`&${entity};`, "text/html").body
				.textContent;
			return decoded || match;
		})
		.replace(/\\(\d{3})([a-zA-Z])/g, (_, octal, char) => {
			const decodedChar = String.fromCharCode(Number.parseInt(octal, 8));
			return decodedChar + char;
		})
		.trim();
}

async function addSubtitlesToVideo(videoPath: string, translatedSubs: Subtitle[]): Promise<string> {
	// Generate a temporary SRT file from translatedSubs
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

		return updatedVideo;
	} catch (error) {
		console.error("Error adding subtitles to video:", error);
		throw error;
	}
}

function formatTime(seconds: number): string {
	const date = new Date(seconds * 1000);
	const hours = date.getUTCHours().toString().padStart(2, "0");
	const minutes = date.getUTCMinutes().toString().padStart(2, "0");
	const secs = date.getUTCSeconds().toString().padStart(2, "0");
	const ms = date.getUTCMilliseconds().toString().padStart(3, "0");
	return `${hours}:${minutes}:${secs},${ms}`;
}
async function summarizeDescription(description: string) {
	const completion = await openai.chat.completions.create({
		model: "gpt-4o-mini", // Use an appropriate model
		messages: [
			{
				role: "system",
				content: JSON.stringify({
					role: "AI assistant",
					task: "Summarize the description",
					instructions: `Provide only the summary of the description in JSON format ({"summary": "..."})`,
				}),
			},
			{
				role: "user",
				content: description,
			},
		],
		response_format: { type: "json_object" },
	});
	return completion.choices[0].message.content;
}
