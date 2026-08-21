const socket = io();

let roomId = "";
let localStream = null;
let peerConnection = null;

let recorder = null;

let uploadSessionId = null;
let uploadedBytes = 0;

let recordingMimeType = "";
let recordingStart = 0;

let segmentTimer = null;

let uploadQueue = Promise.resolve();

let rotating = false;
let shuttingDown = false;


// ======================================================
// SETTINGS
// ======================================================

// 1 HOUR PER GOOGLE DRIVE VIDEO
const RECORDING_DURATION = 60 * 60 * 1000;

// MediaRecorder creates a small piece every 10 seconds.
// These pieces are combined into ONE Drive file.
const MEDIA_TIMESLICE = 10000;

// Google Drive resumable uploads use 256 KiB multiples.
const CHUNK_SIZE = 262144;


// ======================================================
// HTML ELEMENTS
// ======================================================

const startButton =
    document.getElementById("startButton");

const roomInput =
    document.getElementById("roomId");

const localVideo =
    document.getElementById("localVideo");

const statusText =
    document.getElementById("status");

const recordingStatus =
    document.getElementById("recordingStatus");


// ======================================================
// WEBRTC
// ======================================================

const configuration = {
    iceServers: [
        {
            urls: "stun:stun.l.google.com:19302"
        }
    ]
};


// ======================================================
// FIND SUPPORTED MIME TYPE
// ======================================================

function getMimeType() {

    const types = [
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm"
    ];

    for (const type of types) {

        if (MediaRecorder.isTypeSupported(type)) {
            return type;
        }
    }

    return "";
}


// ======================================================
// FILE NAME
// ======================================================

function makeFileName(timestamp) {

    const d = new Date(timestamp);

    const pad = n =>
        String(n).padStart(2, "0");

    return (
        "camera-" +
        d.getFullYear() + "-" +
        pad(d.getMonth() + 1) + "-" +
        pad(d.getDate()) + "_" +
        pad(d.getHours()) + "-" +
        pad(d.getMinutes()) + "-" +
        pad(d.getSeconds()) +
        ".webm"
    );
}


// ======================================================
// CREATE RENDER UPLOAD SESSION
// ======================================================

async function createUploadSession() {

    console.log(
        "Creating Google Drive upload session..."
    );

    const response = await fetch(
        "/api/drive/session",
        {
            method: "POST",

            headers: {
                "Content-Type":
                    "application/json"
            },

            body: JSON.stringify({
                fileName:
                    makeFileName(recordingStart),

                mimeType:
                    recordingMimeType
            })
        }
    );


    let data;

    try {
        data = await response.json();
    } catch {
        throw new Error(
            "Render returned an invalid response while creating the Drive session."
        );
    }


    if (!response.ok) {

        throw new Error(
            data.error ||
            "Google Drive upload session creation failed."
        );
    }


    if (!data.sessionId) {

        throw new Error(
            "Render did not return a Google Drive session ID."
        );
    }


    uploadSessionId =
        data.sessionId;

    uploadedBytes = 0;


    console.log(
        "Google Drive upload session created:",
        uploadSessionId
    );
}


// ======================================================
// SEND CHUNK TO RENDER
// ======================================================

async function sendChunkToRender(
    blob,
    isFinal = false
) {

    if (
        !uploadSessionId ||
        !blob ||
        blob.size === 0
    ) {
        return;
    }


    const buffer =
        await blob.arrayBuffer();


    const bytes =
        new Uint8Array(buffer);


    let offset = 0;


    while (
        offset < bytes.length
    ) {

        const remaining =
            bytes.length - offset;


        // For normal chunks, keep each request
        // at 256 KiB.
        //
        // The final request can be smaller.
        let sendLength;


        if (isFinal) {

            sendLength =
                remaining;

        } else {

            sendLength =
                Math.min(
                    CHUNK_SIZE,
                    remaining
                );
        }


        const start =
            uploadedBytes;


        const end =
            start +
            sendLength -
            1;


        const chunk =
            bytes.slice(
                offset,
                offset + sendLength
            );


        // We don't know the total file size
        // while recording.
        //
        // For the final request, the total is
        // known.
        const total =
            isFinal
                ? end + 1
                : "*";


        const contentRange =
            `bytes ${start}-${end}/${total}`;


        console.log(
            `Sending chunk ${start}-${end}/${total} (${sendLength} bytes)`
        );


        let response;


        try {

            response =
                await fetch(
                    "/api/drive/chunk",
                    {
                        method: "POST",

                        headers: {

                            "Content-Type":
                                "application/octet-stream",

                            "X-Upload-Session":
                                uploadSessionId,

                            "Content-Range":
                                contentRange
                        },

                        body: chunk
                    }
                );

        } catch (error) {

            console.error(
                "Network error uploading chunk:",
                error
            );

            throw new Error(
                "Network error while uploading recording to Render."
            );
        }


        // ============================================
        // UPLOAD COMPLETE
        // ============================================

        if (
            response.status === 200 ||
            response.status === 201
        ) {

            uploadedBytes =
                end + 1;


            console.log(
                "Google Drive file upload completed."
            );


            uploadSessionId =
                null;


            return;
        }


        // ============================================
        // 308 = MORE DATA REQUIRED
        // ============================================

        if (
            response.status === 308
        ) {

            const range =
                response.headers.get(
                    "Range"
                );


            let confirmedBytes;


            if (range) {

                const match =
                    range.match(
                        /bytes=0-(\d+)/
                    );


                if (match) {

                    confirmedBytes =
                        Number(match[1]) + 1;

                } else {

                    confirmedBytes =
                        end + 1;
                }

            } else {

                // If Render doesn't return Range,
                // assume the complete chunk was accepted.
                confirmedBytes =
                    end + 1;
            }


            uploadedBytes =
                confirmedBytes;


            console.log(
                `Google Drive confirmed ${uploadedBytes} bytes`
            );


            // Normally this should be the complete
            // chunk. Move forward.
            offset =
                uploadedBytes -
                start;


            if (
                offset < 0 ||
                offset > bytes.length
            ) {

                throw new Error(
                    "Invalid upload position returned by Google Drive."
                );
            }


            continue;
        }


        // ============================================
        // TEMPORARY SERVER ERROR
        // ============================================

        if (
            response.status >= 500 &&
            response.status <= 599
        ) {

            const text =
                await response.text();

            console.warn(
                `Temporary Drive/Render error ${response.status}:`,
                text
            );


            // Wait before retrying.
            await new Promise(
                resolve =>
                    setTimeout(
                        resolve,
                        3000
                    )
            );


            // Retry the same chunk.
            continue;
        }


        // ============================================
        // OTHER ERROR
        // ============================================

        const errorText =
            await response.text();


        throw new Error(
            `Drive upload failed: ${response.status} ${errorText}`
        );
    }
}


// ======================================================
// QUEUE NORMAL RECORDING CHUNKS
// ======================================================

function queueRecordingChunk(blob) {

    if (
        !blob ||
        blob.size === 0
    ) {
        return;
    }


    console.log(
        `New recording chunk: ${blob.size} bytes`
    );


    uploadQueue =
        uploadQueue.then(
            () =>
                sendChunkToRender(
                    blob,
                    false
                )
        );


    uploadQueue =
        uploadQueue.catch(
            error => {

                console.error(
                    "Google Drive upload error:",
                    error
                );


                recordingStatus.textContent =
                    "❌ Recording upload error";


                // IMPORTANT:
                // Do not silently continue with
                // a broken upload queue.
                throw error;
            }
        );
}


// ======================================================
// STOP MEDIARECORDER
// ======================================================

function stopRecorder() {

    return new Promise(
        (resolve, reject) => {

            if (
                !recorder ||
                recorder.state ===
                    "inactive"
            ) {

                resolve(null);

                return;
            }


            let finalChunk = null;


            const onData =
                event => {

                    if (
                        event.data &&
                        event.data.size > 0
                    ) {

                        finalChunk =
                            event.data;
                    }
                };


            const onStop =
                () => {

                    recorder.removeEventListener(
                        "dataavailable",
                        onData
                    );

                    recorder.removeEventListener(
                        "stop",
                        onStop
                    );

                    recorder.removeEventListener(
                        "error",
                        onError
                    );


                    resolve(
                        finalChunk
                    );
                };


            const onError =
                event => {

                    recorder.removeEventListener(
                        "dataavailable",
                        onData
                    );

                    recorder.removeEventListener(
                        "stop",
                        onStop
                    );

                    recorder.removeEventListener(
                        "error",
                        onError
                    );


                    reject(
                        event.error ||
                        new Error(
                            "MediaRecorder error."
                        )
                    );
                };


            recorder.addEventListener(
                "dataavailable",
                onData
            );


            recorder.addEventListener(
                "stop",
                onStop
            );


            recorder.addEventListener(
                "error",
                onError
            );


            recorder.stop();
        }
    );
}


// ======================================================
// START ONE 1-HOUR RECORDING
// ======================================================

async function startRecording() {

    if (!localStream) {

        throw new Error(
            "Camera stream is not available."
        );
    }


    recordingMimeType =
        getMimeType();


    if (!recordingMimeType) {

        throw new Error(
            "This browser does not support WebM recording."
        );
    }


    recordingStart =
        Date.now();


    // Create a NEW Google Drive file.
    await createUploadSession();


    recorder =
        new MediaRecorder(
            localStream,
            {
                mimeType:
                    recordingMimeType,

                videoBitsPerSecond:
                    2500000,

                audioBitsPerSecond:
                    128000
            }
        );


    recorder.onstart =
        () => {

            console.log(
                "🎥 Recording started."
            );


            recordingStatus.textContent =
                "🔴 Recording to Google Drive";
        };


    recorder.ondataavailable =
        event => {

            if (
                event.data &&
                event.data.size > 0
            ) {

                queueRecordingChunk(
                    event.data
                );
            }
        };


    recorder.onerror =
        event => {

            console.error(
                "MediaRecorder error:",
                event.error
            );


            recordingStatus.textContent =
                "❌ Camera recording error";
        };


    recorder.start(
        MEDIA_TIMESLICE
    );


    // Schedule the one-hour rotation.
    segmentTimer =
        setTimeout(
            rotateRecording,
            RECORDING_DURATION
        );
}


// ======================================================
// ROTATE RECORDING AFTER 1 HOUR
// ======================================================

async function rotateRecording() {

    if (
        rotating ||
        shuttingDown
    ) {
        return;
    }


    rotating = true;


    clearTimeout(
        segmentTimer
    );


    console.log(
        "⏰ One hour reached."
    );


    recordingStatus.textContent =
        "⏳ Finishing 1-hour recording...";


    try {

        // Stop MediaRecorder.
        //
        // This generates the final dataavailable
        // event before the stop event.
        const finalChunk =
            await stopRecorder();


        // Wait for every previous 10-second
        // chunk to finish uploading.
        await uploadQueue;


        // Upload the FINAL chunk.
        //
        // This request contains the final file size
        // so Google Drive can finish the file.
        if (
            finalChunk &&
            finalChunk.size > 0
        ) {

            console.log(
                `Final recording chunk: ${finalChunk.size} bytes`
            );


            await sendChunkToRender(
                finalChunk,
                true
            );
        }


        console.log(
            "✅ 1-hour recording saved to Google Drive."
        );


        recordingStatus.textContent =
            "✅ 1-hour recording saved";


        // Reset the queue for the next file.
        uploadQueue =
            Promise.resolve();


        uploadedBytes =
            0;


        uploadSessionId =
            null;


        // Wait a moment before starting
        // the next hour.
        await new Promise(
            resolve =>
                setTimeout(
                    resolve,
                    1000
                )
        );


        if (
            !shuttingDown
        ) {

            await startRecording();
        }


    } catch (error) {

        console.error(
            "❌ Recording rotation/upload error:",
            error
        );


        recordingStatus.textContent =
            "❌ Recording upload error";


    } finally {

        rotating = false;
    }
}


// ======================================================
// START CAMERA
// ======================================================

startButton.addEventListener(
    "click",
    async () => {

        roomId =
            roomInput.value.trim();


        if (!roomId) {

            alert(
                "Enter a Room ID"
            );

            return;
        }


        startButton.disabled =
            true;


        try {

            // Camera + microphone.
            localStream =
                await navigator
                    .mediaDevices
                    .getUserMedia(
                        {
                            video: true,
                            audio: true
                        }
                    );


            localVideo.srcObject =
                localStream;


            socket.emit(
                "join-room",
                roomId
            );


            statusText.textContent =
                "Camera started. Waiting for viewer...";


            await startRecording();


        } catch (error) {

            console.error(
                "Camera start error:",
                error
            );


            alert(
                error.message ||
                "Could not access camera/microphone."
            );


            startButton.disabled =
                false;
        }
    }
);


// ======================================================
// VIEWER CONNECTED
// ======================================================

socket.on(
    "user-joined",
    async () => {

        if (!localStream) {
            return;
        }


        peerConnection =
            new RTCPeerConnection(
                configuration
            );


        localStream
            .getTracks()
            .forEach(
                track => {

                    peerConnection.addTrack(
                        track,
                        localStream
                    );
                }
            );


        peerConnection.onicecandidate =
            event => {

                if (
                    event.candidate
                ) {

                    socket.emit(
                        "ice-candidate",
                        {
                            roomId,
                            candidate:
                                event.candidate
                        }
                    );
                }
            };


        try {

            const offer =
                await peerConnection
                    .createOffer();


            await peerConnection
                .setLocalDescription(
                    offer
                );


            socket.emit(
                "offer",
                {
                    roomId,
                    offer
                }
            );


            statusText.textContent =
                "Viewer connected. Connecting...";


        } catch (error) {

            console.error(
                "Offer error:",
                error
            );
        }
    }
);


// ======================================================
// RECEIVE ANSWER
// ======================================================

socket.on(
    "answer",
    async answer => {

        if (!peerConnection) {
            return;
        }


        try {

            await peerConnection
                .setRemoteDescription(
                    new RTCSessionDescription(
                        answer
                    )
                );


            statusText.textContent =
                "🔴 LIVE";


        } catch (error) {

            console.error(
                "Answer error:",
                error
            );
        }
    }
);


// ======================================================
// RECEIVE ICE CANDIDATE
// ======================================================

socket.on(
    "ice-candidate",
    async candidate => {

        if (!peerConnection) {
            return;
        }


        try {

            await peerConnection
                .addIceCandidate(
                    new RTCIceCandidate(
                        candidate
                    )
                );


        } catch (error) {

            console.error(
                "ICE candidate error:",
                error
            );
        }
    }
);


// ======================================================
// PAGE CLOSING
// ======================================================

window.addEventListener(
    "beforeunload",
    () => {

        shuttingDown = true;


        if (segmentTimer) {

            clearTimeout(
                segmentTimer
            );
        }


        if (
            recorder &&
            recorder.state !==
                "inactive"
        ) {

            try {

                recorder.stop();

            } catch (error) {

                console.error(
                    "Recorder stop error:",
                    error
                );
            }
        }


        if (localStream) {

            localStream
                .getTracks()
                .forEach(
                    track =>
                        track.stop()
                );
        }
    }
);
