const socket = io();

let roomId = "";
let localStream = null;
let peerConnection = null;
let recorder = null;

let driveUploadUrl = null;
let uploadedBytes = 0;

let recordingMimeType = "";
let recordingStart = 0;

let segmentTimer = null;

let uploadQueue = Promise.resolve();

let stoppingForRotation = false;
let shuttingDown = false;

const CHUNK_SIZE = 262144; // 256 KiB
const RECORDING_DURATION = 60 * 60 * 1000; // 1 HOUR
const MEDIA_TIMESLICE = 10000; // 10 seconds

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

const configuration = {
    iceServers: [
        {
            urls: "stun:stun.l.google.com:19302"
        }
    ]
};


// =====================================================
// MIME TYPE
// =====================================================

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


// =====================================================
// FILE NAME
// =====================================================

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


// =====================================================
// CREATE DRIVE SESSION
// =====================================================

async function createDriveSession() {

    console.log(
        "Creating new Google Drive upload session..."
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

    const data =
        await response.json();

    if (!response.ok) {

        throw new Error(
            data.error ||
            "Could not create Google Drive upload session."
        );
    }

    if (!data.uploadUrl) {

        throw new Error(
            "Google Drive did not return an upload URL."
        );
    }

    driveUploadUrl =
        data.uploadUrl;

    uploadedBytes = 0;

    console.log(
        "Google Drive upload session created."
    );
}


// =====================================================
// GET CURRENT DRIVE UPLOAD POSITION
//
// IMPORTANT:
// Google says after a failed/503 upload we must
// ask Drive how many bytes it actually received.
// =====================================================

async function getDriveUploadPosition() {

    if (!driveUploadUrl) {
        throw new Error(
            "Drive upload URL is missing."
        );
    }

    console.log(
        "Checking Google Drive upload position..."
    );

    const response = await fetch(
        driveUploadUrl,
        {
            method: "PUT",

            headers: {
                "Content-Range": "*/*",
                "Content-Length": "0"
            }
        }
    );

    if (
        response.status === 200 ||
        response.status === 201
    ) {

        console.log(
            "Google Drive says upload is already complete."
        );

        return {
            completed: true,
            position: uploadedBytes
        };
    }

    if (response.status === 308) {

        const range =
            response.headers.get("Range");

        if (!range) {

            console.log(
                "Google Drive reports 0 confirmed bytes."
            );

            uploadedBytes = 0;

            return {
                completed: false,
                position: 0
            };
        }

        const match =
            range.match(/bytes=0-(\d+)/);

        if (!match) {

            uploadedBytes = 0;

            return {
                completed: false,
                position: 0
            };
        }

        const position =
            Number(match[1]) + 1;

        uploadedBytes =
            position;

        console.log(
            `Google Drive confirmed ${position} bytes.`
        );

        return {
            completed: false,
            position
        };
    }

    if (response.status === 404) {

        throw new Error(
            "Google Drive upload session expired."
        );
    }

    const text =
        await response.text();

    throw new Error(
        `Could not check Drive upload position: ${response.status} ${text}`
    );
}


// =====================================================
// UPLOAD ONE CHUNK
// =====================================================

async function uploadChunk(blob, isFinal = false) {

    if (
        !driveUploadUrl ||
        !blob ||
        blob.size === 0
    ) {
        return;
    }

    const bytes =
        new Uint8Array(
            await blob.arrayBuffer()
        );

    let offset = 0;

    while (
        offset < bytes.length
    ) {

        const currentStart =
            uploadedBytes;

        const remaining =
            bytes.length - offset;

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

        const currentEnd =
            currentStart +
            sendLength -
            1;

        const body =
            bytes.slice(
                offset,
                offset + sendLength
            );

        const total =
            isFinal
                ? currentEnd + 1
                : "*";

        console.log(
            `Sending Drive chunk ${currentStart}-${currentEnd}/${total} (${sendLength} bytes)`
        );

        let response;

        try {

            response = await fetch(
                driveUploadUrl,
                {
                    method: "PUT",

                    headers: {
                        "Content-Type":
                            recordingMimeType,

                        "Content-Length":
                            String(sendLength),

                        "Content-Range":
                            `bytes ${currentStart}-${currentEnd}/${total}`
                    },

                    body
                }
            );

        } catch (error) {

            console.error(
                "Network error during Drive upload:",
                error
            );

            // Ask Drive what it actually received.
            await getDriveUploadPosition();

            offset =
                uploadedBytes -
                currentStart;

            if (
                offset < 0 ||
                offset > bytes.length
            ) {
                throw error;
            }

            continue;
        }


        // =============================================
        // COMPLETE
        // =============================================

        if (
            response.status === 200 ||
            response.status === 201
        ) {

            uploadedBytes =
                currentEnd + 1;

            console.log(
                `Google Drive upload completed at ${uploadedBytes} bytes.`
            );

            return;
        }


        // =============================================
        // RESUME INCOMPLETE
        // =============================================

        if (response.status === 308) {

            const range =
                response.headers.get("Range");

            let confirmed;

            if (range) {

                const match =
                    range.match(/bytes=0-(\d+)/);

                confirmed =
                    match
                        ? Number(match[1]) + 1
                        : currentEnd + 1;

            } else {

                confirmed =
                    currentEnd + 1;
            }

            uploadedBytes =
                confirmed;

            offset =
                uploadedBytes -
                currentStart;

            console.log(
                `Google Drive confirmed ${uploadedBytes} bytes.`
            );

            continue;
        }


        // =============================================
        // 5xx SERVER ERROR
        // =============================================

        if (
            response.status >= 500 &&
            response.status <= 599
        ) {

            console.warn(
                `Google Drive returned ${response.status}. Checking upload position...`
            );

            await new Promise(
                resolve =>
                    setTimeout(resolve, 2000)
            );

            await getDriveUploadPosition();

            offset =
                uploadedBytes -
                currentStart;

            if (
                offset < 0 ||
                offset > bytes.length
            ) {

                throw new Error(
                    "Drive upload position became invalid."
                );
            }

            continue;
        }


        // =============================================
        // OTHER ERROR
        // =============================================

        const errorText =
            await response.text();

        throw new Error(
            `Drive upload failed: ${response.status} ${errorText}`
        );
    }
}


// =====================================================
// QUEUE MEDIARECORDER DATA
// =====================================================

function queueChunk(blob) {

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
                uploadChunk(
                    blob,
                    false
                )
        );
}


// =====================================================
// FINALIZE THE LAST CHUNK
// =====================================================

async function finalizeFinalChunk(blob) {

    if (
        !blob ||
        blob.size === 0
    ) {
        return;
    }

    console.log(
        `Final recording chunk: ${blob.size} bytes`
    );

    await uploadChunk(
        blob,
        true
    );
}


// =====================================================
// WAIT FOR MEDIARECORDER STOP
// =====================================================

function stopRecorderAndWait() {

    return new Promise(
        (resolve, reject) => {

            if (
                !recorder ||
                recorder.state === "inactive"
            ) {

                resolve();

                return;
            }

            let finished = false;

            const finish = () => {

                if (finished) {
                    return;
                }

                finished = true;

                resolve();
            };

            recorder.addEventListener(
                "stop",
                finish,
                {
                    once: true
                }
            );

            recorder.addEventListener(
                "error",
                event => {

                    console.error(
                        "MediaRecorder error:",
                        event.error
                    );

                    if (!finished) {

                        finished = true;

                        reject(
                            event.error ||
                            new Error(
                                "MediaRecorder error."
                            )
                        );
                    }
                },
                {
                    once: true
                }
            );

            try {

                recorder.stop();

            } catch (error) {

                if (!finished) {

                    finished = true;

                    reject(error);
                }
            }
        }
    );
}


// =====================================================
// START NEW 1-HOUR RECORDING
// =====================================================

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


    // New Drive file for every hour.
    await createDriveSession();


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


    recorder.ondataavailable =
        event => {

            if (
                event.data &&
                event.data.size > 0
            ) {

                // During normal recording,
                // upload chunks sequentially.
                queueChunk(
                    event.data
                );
            }
        };


    recorder.onerror =
        event => {

            console.error(
                "❌ MediaRecorder error:",
                event.error
            );

            recordingStatus.textContent =
                "❌ Camera recording error";
        };


    recorder.onstart =
        () => {

            console.log(
                "🎥 Recording started."
            );

            recordingStatus.textContent =
                "🔴 Recording to Google Drive";
        };


    // Every 10 seconds the browser gives us
    // a Blob. These are NOT separate video files.
    // They are pieces of the current 1-hour file.
    recorder.start(
        MEDIA_TIMESLICE
    );


    // One-hour rotation.
    segmentTimer =
        setTimeout(
            rotateRecording,
            RECORDING_DURATION
        );
}


// =====================================================
// ROTATE AFTER ONE HOUR
// =====================================================

async function rotateRecording() {

    if (
        stoppingForRotation ||
        shuttingDown
    ) {
        return;
    }

    stoppingForRotation = true;

    clearTimeout(
        segmentTimer
    );

    console.log(
        "⏰ One hour reached."
    );

    recordingStatus.textContent =
        "⏳ Finishing 1-hour recording...";


    try {

        // ------------------------------------------------
        // IMPORTANT:
        // MediaRecorder.stop() produces a FINAL
        // dataavailable event BEFORE stop.
        //
        // We capture that final chunk separately.
        // ------------------------------------------------

        let finalChunkPromise =
            new Promise(
                resolve => {

                    if (
                        !recorder ||
                        recorder.state ===
                            "inactive"
                    ) {

                        resolve(null);

                        return;
                    }

                    const handler =
                        event => {

                            recorder.removeEventListener(
                                "dataavailable",
                                handler
                            );

                            if (
                                event.data &&
                                event.data.size > 0
                            ) {

                                resolve(
                                    event.data
                                );

                            } else {

                                resolve(null);
                            }
                        };

                    recorder.addEventListener(
                        "dataavailable",
                        handler
                    );
                }
            );


        // Stop the current recorder.
        await stopRecorderAndWait();


        // The final dataavailable event has now
        // been delivered.
        const finalChunk =
            await finalChunkPromise;


        // Wait for all normal 10-second chunks.
        await uploadQueue;


        // Upload the final chunk as the FINAL
        // Drive request.
        if (finalChunk) {

            await finalizeFinalChunk(
                finalChunk
            );
        }


        console.log(
            "✅ 1-hour recording completely uploaded to Google Drive."
        );

        recordingStatus.textContent =
            "✅ 1-hour recording saved";


        // ------------------------------------------------
        // NOW create the next recording.
        //
        // We do NOT start it until the previous
        // recording is completely finished.
        // ------------------------------------------------

        await startRecording();


    } catch (error) {

        console.error(
            "❌ 1-hour recording upload error:",
            error
        );

        recordingStatus.textContent =
            "❌ Recording upload error";

    } finally {

        stoppingForRotation = false;
    }
}


// =====================================================
// START CAMERA BUTTON
// =====================================================

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


// =====================================================
// VIEWER JOINED
// =====================================================

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
            .forEach(track => {

                peerConnection.addTrack(
                    track,
                    localStream
                );
            });


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


// =====================================================
// ANSWER
// =====================================================

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


// =====================================================
// ICE CANDIDATE
// =====================================================

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


// =====================================================
// PAGE CLOSING
// =====================================================

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
                    "Stop error:",
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
