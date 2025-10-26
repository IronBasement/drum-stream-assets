import asyncio
import os
from shazamio import Shazam
from moviepy import *

def toMP3(mp4):
    try:
        video_clip = VideoFileClip(mp4)
        audio_clip = video_clip.audio

        name, extension = os.path.splitext(mp4)
        name = name+".mp3"
        audio_clip.write_audiofile(name)

        audio_clip.close()
        video_clip.close()

        return(name)

    except Exception as e:
        print(f"An error occurred: {e}")


async def identifySong(path):
  shazam = Shazam()
  out = await shazam.recognize(path)
  return(out)

async def genre(mp4):
    mp3 = toMP3(mp4)
    info = await identifySong(mp3)
    os.remove(mp3)
    return(info["track"]["genres"]["primary"])
    

