import { createChromakey } from "./chromakey";
import { MP4Demuxer, MP4Muxer, stream2buffer } from "./mp4-utils";
import { drawFrame } from "./drawFrame";

window.createVideo = generate

/**
 * 创建视频
 * @param {ArrayBuffer} baseVideo 基础视频
 * @param {ArrayBuffer} effectVideo 特效视频
 * @returns {Promise<string>}
 */
async function generate(baseVideo, effectVideo) {

  // turn ArrayBuffer into File
  const baseVideoFile = new File([baseVideo], "base.mp4", { type: "video/mp4" });
  const effectVideoFile = new File([effectVideo], "effect.mp4", { type: "video/mp4" });

  let videoFrameQueue = [];
  let chromaFrameQueue = [];

  let videoFrames = [];
  let chromaFrames = [];
  const chromakey = createChromakey({
    similarity: 0.18,
    smoothness: 0.1,
    spill: 0.2,
  });

  const decoder = new VideoDecoder({
    output: (chunk) => {
      // console.log("video", chunk);
      videoFrames.push(new VideoFrame(chunk));
      chunk.close();
    },
    error: (error) => {
      console.error(error);
    },
  });

  const decoder2 = new VideoDecoder({
    output: async (chunk) => {
      // console.log("chromakey", chunk);
      await chromakey(chunk).then((resFrame) => {
        chromaFrames.push(new VideoFrame(resFrame));
        chunk.close();
      });
    },
    error: (error) => {
      console.error(error);
    },
  });

  await new Promise((resolve) => {
    // 普通视频处理
    new MP4Demuxer(baseVideoFile, {
      onConfig(config) {
        // 1. 配置解码器
        console.log("config", JSON.stringify(config));
        decoder.configure(config);
      },
      onChunk(chunk) {
        // 2. 解码视频帧
        // console.log("chunk", chunk);
        // decoder.decode(chunk);
        videoFrameQueue.push(chunk);
      },
      onDone() {
        // 4.视频解封装完成
        // console.log("demux done");
        resolve('done');
      },
    });
  })

  await new Promise((resolve) => {
    // 特效视频处理
    new MP4Demuxer(effectVideoFile, {
      onConfig(config) {
        // 1. 配置解码器
        console.log("config", JSON.stringify(config));
        decoder2.configure(config);
      },
      onChunk(chunk) {
        // 2. 解码视频帧
        // console.log("chunk", chunk);
        // decoder2.decode(chunk);
        chromaFrameQueue.push(chunk);
      },
      onDone() {
        // 4.视频解封装完成
        console.log("chromaFrames done");
        resolve('done');
      },
    });
  })

  // check if queue is empty every 50ms decode if not empty
  await new Promise((resolve) => {
    const decodeInterval = setInterval(() => {
      if (videoFrameQueue.length > 0) {
        decoder.decode(videoFrameQueue.shift());
      }
      if (chromaFrameQueue.length > 0) {
        decoder2.decode(chromaFrameQueue.shift());
      }
      if (videoFrameQueue.length === 0 && chromaFrameQueue.length === 0) {
        clearInterval(decodeInterval);
        resolve('done');
      }
    }, 50);
  })

  // 视频合成
  const mp4Muxer = new MP4Muxer();
  let track_id = -1;
  const encoder = new VideoEncoder({
    output: async (chunk, meta) => {
      if (track_id < 1 && meta != null) {
        const videoMuxConfig = {
          timescale: 1e6,
          width: 1920,
          height: 1080,
          // meta 来原于 VideoEncoder output 的参数
          avcDecoderConfigRecord:
            meta?.decoderConfig?.description,
        };
        console.log("add track", videoMuxConfig);
        track_id = mp4Muxer.addTrack(videoMuxConfig);
      }
      // console.log("add video chunk", chunk);
      mp4Muxer.addVideoChunk(track_id, chunk);
    },
    error: (error) => {
      console.error(error);
    },
  });
  encoder.configure({
    codec: "avc1.4D0032",
    width: 1920,
    height: 1080,
    bitrate: 25000000,
    framerate: 24,
  });
  const renderCanvas = new OffscreenCanvas(1920, 1080);
  const renderCtx = renderCanvas.getContext("webgl2");
  if (!renderCtx) {
    console.error(
      "Unable to initialize WebGL2. Your browser may not support it."
    );
    return;
  }
  let index = 0;
  let chromaIndex = 0;
  let timeoffset = 0;
  let interval = 1000 / 24;
  let resBuffer = null
  await new Promise((resolve) => {
    const renderFrame = async () => {
      console.log("renderFrame", index, videoFrames.length);
      if (index < videoFrames.length) {
        const frame = videoFrames[index];
        const chromaFrame = chromaFrames[chromaIndex];
        drawFrame(
          renderCtx,
          frame,
          chromaFrame,
          index,
          videoFrames.length
        );
        const duration = interval * 1000;
        const queuedFrame = new VideoFrame(renderCanvas, {
          duration,
          timestamp: timeoffset,
        });
        encoder.encode(queuedFrame);
        timeoffset += duration;
        index++;
        chromaIndex++;
        if (chromaIndex >= chromaFrames.length) chromaIndex = 0;
      } else {
        clearInterval(renderInterval);
        await encoder.flush();
        videoFrameQueue.forEach((frame) => frame.close());
        videoFrameQueue = [];
        let stream = mp4Muxer.mp4file2stream(1);
        const buffer = await stream2buffer(stream.stream);
        resBuffer = buffer;
        resolve('done');
      }
    };
    const renderInterval = setInterval(renderFrame, 1);
  })
  const blob = new Blob([resBuffer], { type: "video/mp4" });
  const reader = new FileReader();
  const binString = await new Promise((resolve) => {
    reader.onload = () => {
      resolve(reader.result);
    };
    reader.readAsBinaryString(blob);
  })
  // console.log("binString", binString);
  return binString;
}