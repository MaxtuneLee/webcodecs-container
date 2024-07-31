import * as MP4Box from "mp4box";

/**
 * buffer 转换为 MP4Box file
 */
export class MP4FileSink {
    #file = null;
    #offset = 0;

    constructor(file) {
        this.#file = file;
    }

    write(chunk) {
        const buffer = new ArrayBuffer(chunk.byteLength);
        new Uint8Array(buffer).set(chunk);

        buffer.fileStart = this.#offset;
        this.#offset += buffer.byteLength;

        console.log("read", (this.#offset / 1024 ** 2).toFixed(1) + " MiB");
        this.#file.appendBuffer(buffer);
    }

    close() {
        console.log("read", "Done");
        this.#file.flush();
    }
}

/**
 * MP4 解封装器
 */
export class MP4Demuxer {
    #onConfig = null;
    #onChunk = null;
    #file = null;

    /**
     * 构建mp4file
     * @param {File} file 
     * @param {*} param1 
     */
    constructor(file, { onConfig, onChunk, onDone }) {
        this.#onConfig = onConfig;
        this.#onChunk = onChunk;

        this.#file = MP4Box.createFile();
        this.#file.onError = (error) => console.log("demux", error);
        this.#file.onReady = this.#onReady.bind(this);
        this.#file.onSamples = this.#onSamples.bind(this);

        const fileSink = new MP4FileSink(this.#file);
        const reader = file.stream().getReader();
        reader.read().then(async function processChunk({ done, value }) {
            if (done) {
                fileSink.close();
                onDone?.();
                return;
            }
            fileSink.write(value);
            reader.read().then(processChunk);
        });
    }

    #description(track) {
        const trak = this.#file.getTrackById(track.id);
        for (const entry of trak.mdia.minf.stbl.stsd.entries) {
            const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
            if (box) {
                const stream = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN);
                box.write(stream);
                return new Uint8Array(stream.buffer, 8);
            }
        }
        throw new Error("avcC, hvcC, vpcC, or av1C box not found");
    }

    #onReady(info) {
        console.log("demux", "Ready");
        const track = info.videoTracks[0];

        this.#onConfig?.({
            codec: track.codec.startsWith("vp08") ? "vp8" : track.codec,
            codedHeight: track.video.height,
            codedWidth: track.video.width,
            description: this.#description(track),
        });

        this.#file.setExtractionOptions(track.id);
        this.#file.start();
    }

    #onSamples(track_id, ref, samples) {
        for (const sample of samples) {
            this.#onChunk?.(
                new EncodedVideoChunk({
                    type: sample.is_sync ? "key" : "delta",
                    timestamp: (1e6 * sample.cts) / sample.timescale,
                    duration: (1e6 * sample.duration) / sample.timescale,
                    data: sample.data,
                })
            );
        }
    }
}

/** MP4封装器 */
export class MP4Muxer {
    #file = null;
    tracks = new WeakMap();

    constructor() {
        this.#file = MP4Box.createFile();
    }

    addTrack(config) {
        const trackId = this.#file.addTrack(config);
        this.tracks.set(config, trackId);
        return trackId;
    }

    addVideoChunk(trackId, chunk) {
        const videoSampleOpts = this.chunk2MP4SampleOpts(chunk);
        this.#file.addSample(trackId, videoSampleOpts.data, videoSampleOpts);
    }

    /**
     * EncodedAudioChunk | EncodedVideoChunk 转换为 MP4 addSample 需要的参数
     */
    chunk2MP4SampleOpts(chunk) {
        const buf = new ArrayBuffer(chunk.byteLength);
        chunk.copyTo(buf);
        const dts = chunk.timestamp;
        return {
            duration: chunk.duration ?? 0,
            dts,
            cts: dts,
            is_sync: chunk.type === "key",
            data: buf,
        };
    }

    /**
     * 将 mp4box file 转换为文件流，用于上传服务器或存储到本地
     * @param timeSlice - 时间片，用于控制流的发送速度。
     * @param onCancel - 当返回的流被取消时触发该回调函数
     */
    mp4file2stream(timeSlice, onCancel) {
        console.log("video stream creating...");
        let file = this.#file;
        let timerId = 0;

        let sendedBoxIdx = 0;
        const boxes = file.boxes;

        let firstMoofReady = false;
        const deltaBuf = () => {
            if (!firstMoofReady) {
                if (boxes.find((box) => box.type === "moof") != null) {
                    firstMoofReady = true;
                } else {
                    return null;
                }
            }
            if (sendedBoxIdx >= boxes.length) return null;

            const ds = new MP4Box.DataStream();
            ds.endianness = MP4Box.DataStream.BIG_ENDIAN;

            try {
                boxes[sendedBoxIdx].write(ds);
                delete boxes[sendedBoxIdx];
                sendedBoxIdx += 1;
            } catch (err) {
                const errBox = boxes[sendedBoxIdx];
                if (err instanceof Error && errBox != null) {
                    throw Error(
                        `${err.message} | deltaBuf( boxType: ${errBox.type}, boxSize: ${errBox.size}, boxDataLen: ${errBox.data?.length ?? -1})`
                    );
                }
                throw err;
            }

            return new Uint8Array(ds.buffer);
        };

        let stoped = false;
        let canceled = false;
        let exit = null;
        const stream = new ReadableStream({
            start(ctrl) {
                timerId = self.setInterval(() => {
                    const d = deltaBuf();
                    console.log("video stream sending...", d);
                    if (d != null && !canceled) ctrl.enqueue(d);
                    if (sendedBoxIdx >= boxes.length || stoped) exit?.();
                }, timeSlice);

                exit = (err) => {
                    console.log("video stream exiting...");
                    clearInterval(timerId);
                    file.flush();
                    if (err != null) {
                        ctrl.error(err);
                        return;
                    }

                    const d = deltaBuf();
                    if (d != null && !canceled) ctrl.enqueue(d);

                    if (!canceled) {
                        ctrl.close();
                        console.log("video stream closed");
                    }
                };

                // 安全起见，检测如果start触发时已经 stoped
                if (stoped) exit();
            },
            cancel() {
                canceled = true;
                clearInterval(timerId);
                onCancel?.();
            },
        });

        return {
            stream,
            stop: (err) => {
                if (stoped) return;
                stoped = true;
                exit?.(err);
            },
        };
    }

    close() {
        this.#file.flush();
    }
}

/**
 * 强行回收 mp4boxfile 尽量降低内存占用，会破坏 file 导致无法正常使用
 * 仅用于获取二进制后，不再需要任何 file 功能的场景
 */
export function unsafeReleaseMP4BoxFile(file) {
    if (file.moov == null) return;
    for (var j = 0; j < file.moov.traks.length; j++) {
        file.moov.traks[j].samples = [];
    }
    file.mdats = [];
    file.moofs = [];
}

/**
 * 转换readablestream为Uint8Array
 * @param {ReadableStream} stream
 * @returns {Promise<Uint8Array>}
 */
export function stream2buffer(stream) {
    const reader = stream.getReader();
    const chunks = [];
    console.log("stream2buffer start");
    return new Promise((resolve, reject) => {
        function read() {
            reader.read().then(({ done, value }) => {
                if (done) {
                    // Concatenate all Uint8Array chunks into a single Uint8Array.
                    const totalLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
                    const result = new Uint8Array(totalLength);
                    let offset = 0;
                    for (const chunk of chunks) {
                        result.set(chunk, offset);
                        offset += chunk.length;
                    }
                    resolve(result);
                    return;
                }
                chunks.push(value);
                read();
            }).catch(reject);
        }
        read();
    });
}
