import {
	logger,
	getLatestFireshipVideo,
	getLastUploadedVideoId,
	getSubtitles,
	downloadVideo,
	addSubtitlesToVideo,
	uploadVideoToTelegram,
	setLastUploadedVideoId,
} from "./bot";
import { getFixedSubtitles } from "./getFixedSubtitles";

export async function checkAndUploadNewVideo(): Promise<void> {
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

	try {
		const subtitles = await getSubtitles(video.id);
		const fixedSubtitles = getFixedSubtitles(subtitles);
		// const translatedSubs = await translateSubs(fixedSubtitles, "Russian");
		const videoPath = await downloadVideo(video.id);
		const videoWithSubsPath = await addSubtitlesToVideo(videoPath, fixedSubtitles);
		await uploadVideoToTelegram(videoWithSubsPath, video, fixedSubtitles);
		await setLastUploadedVideoId(video.id);
		logger.info("Video uploaded successfully", { videoId: video.id });
	} catch (error) {
		logger.error("Error uploading video", { videoId: video.id, error });
		console.error("Error uploading video:", error);
	}
}
