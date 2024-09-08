export function formatTime(seconds: number): string {
	const date = new Date(seconds * 1000);
	const hours = date.getUTCHours().toString().padStart(2, "0");
	const minutes = date.getUTCMinutes().toString().padStart(2, "0");
	const secs = date.getUTCSeconds().toString().padStart(2, "0");
	const ms = date.getUTCMilliseconds().toString().padStart(3, "0");
	return `${hours}:${minutes}:${secs},${ms}`;
}
