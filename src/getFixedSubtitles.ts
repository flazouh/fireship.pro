import { Subtitle } from "./bot";

export function getFixedSubtitles(subtitles: Subtitle[] | null): Subtitle[] {
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
