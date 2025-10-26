import asyncio
import sys
import songInfo


async def main(mp4):
    print(await songInfo.genre(mp4))


# Usage python test.py <path to video file downloaded from youtube
if __name__ == "__main__":
    asyncio.run(main(sys.argv[1]))

