import { Telegraf } from 'telegraf';
import { config } from 'dotenv';
import axios from 'axios';
import { Groq } from 'groq-sdk';
import { PrismaClient } from '@prisma/client';
import { parseStringPromise } from 'xml2js';

config();

const prisma = new PrismaClient();
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const FIRESHIP_CHANNEL_ID = 'UCsBjURrPoezykLs9EqgamOA';
const VIDEO_CHANNEL_ID = process.env.VIDEO_CHANNEL_ID!;
const SUBTITLE_CHANNEL_ID = process.env.SUBTITLE_CHANNEL_ID!;

interface Video {
  id: string;
  title: string;
  description: string;
  thumbnailUrl: string;
}

async function getLatestFireshipVideo(): Promise<Video | null> {
  try {
    const response = await axios.get(`https://www.youtube.com/feeds/videos.xml?channel_id=${FIRESHIP_CHANNEL_ID}`);
    const result = await parseStringPromise(response.data);
    const latestVideo = result.feed.entry[0];

    if (!latestVideo) return null;

    return {
      id: latestVideo['yt:videoId'][0],
      title: latestVideo.title[0],
      description: latestVideo['media:group'][0]['media:description'][0],
      thumbnailUrl: `https://i.ytimg.com/vi/${latestVideo['yt:videoId'][0]}/hqdefault.jpg`,
    };
  } catch (error) {
    console.error('Error fetching latest Fireship video:', error);
    return null;
  }
}

async function getVideoSubtitles(videoId: string): Promise<string> {
  try {
    // Note: This function needs to be implemented differently without the YouTube API
    // You might need to use a third-party service or library to fetch subtitles
    console.warn('Subtitle fetching not implemented without YouTube API');
    return '';
  } catch (error) {
    console.error('Error fetching video subtitles:', error);
    return '';
  }
}

async function correctSubtitles(subtitles: string): Promise<string> {
  try {
    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: 'You are an AI assistant that corrects and improves subtitles.',
        },
        {
          role: 'user',
          content: `Please correct and improve the following subtitles:\n\n${subtitles}`,
        },
      ],
      model: 'mixtral-8x7b-32768',
    });

    return completion.choices[0]?.message?.content || subtitles;
  } catch (error) {
    console.error('Error correcting subtitles with Groq:', error);
    return subtitles;
  }
}

async function uploadVideoToTelegram(video: Video): Promise<number> {
  try {
    const message = await bot.telegram.sendVideo(VIDEO_CHANNEL_ID, video.thumbnailUrl, {
      caption: `${video.title}\n\n${video.description}\n\nhttps://www.youtube.com/watch?v=${video.id}`,
    });
    console.log('Video uploaded to Telegram:', message);
    return message.message_id;
  } catch (error) {
    console.error('Error uploading video to Telegram:', error);
    throw error;
  }
}

async function uploadSubtitlesToTelegram(messageId: number, subtitles: string): Promise<void> {
  try {
    await bot.telegram.sendMessage(SUBTITLE_CHANNEL_ID, subtitles, {
      reply_parameters :{
        message_id: messageId,
      }
    });
  } catch (error) {
    console.error('Error uploading subtitles to Telegram:', error);
  }
}

async function checkAndUploadNewVideo(): Promise<void> {
  const video = await getLatestFireshipVideo();
  if (!video) return;

  const lastUploadedVideoId = await getLastUploadedVideoId();
  if (video.id === lastUploadedVideoId) return;

  const messageId = await uploadVideoToTelegram(video);
  await setLastUploadedVideoId(video.id);

  const subtitles = await getVideoSubtitles(video.id);
  const correctedSubtitles = await correctSubtitles(subtitles);
  await uploadSubtitlesToTelegram(messageId, correctedSubtitles);
}

// Update these functions to use Prisma
async function getLastUploadedVideoId(): Promise<string> {
  const lastVideo = await prisma.uploadedVideo.findFirst({
    orderBy: { uploadedAt: 'desc' },
  });
  return lastVideo?.id ?? '';
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
  setInterval(checkAndUploadNewVideo, 60 * 60 * 1000); // Check every hour
}

// Run the main function
main().catch(console.error);

// Enable graceful stop
process.once('SIGINT', async () => {
  bot.stop('SIGINT');
  await prisma.$disconnect();
});
process.once('SIGTERM', async () => {
  bot.stop('SIGTERM');
  await prisma.$disconnect();
});