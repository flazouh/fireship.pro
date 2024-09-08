import {
	logger,
	getLatestFireshipVideo,
	getLastUploadedVideoId,
	uploadVideoToTelegram,
	setLastUploadedVideoId,
} from "./bot";

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
		await uploadVideoToTelegram(video);
		await setLastUploadedVideoId(video.id, video.title);
		logger.info("Video uploaded successfully", { videoId: video.id });
	} catch (error) {
		logger.error("Error uploading video", { videoId: video.id, error });
		console.error("Error uploading video:", error);
	}
}
