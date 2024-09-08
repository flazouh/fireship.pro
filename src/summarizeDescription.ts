import { logger, openai } from "./bot";

export async function summarizeDescription(description: string): Promise<string> {
	logger.info("Summarizing video description");
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
				content: description,
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
