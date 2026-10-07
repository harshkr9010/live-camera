const socket = io();

let roomId = "";
let localStream = null;

const peerConnections = new Map();

let cameraStarted = false;

// ======================================================
// RECORDING SETTINGS
// ======================================================

const RECORDING_LENGTH = 15 * 60 * 1000; // 15 minutes
const RECORDING_CHUNK = 1000; // save recorder data every 1 second

let mediaRecorder = null;
let recordingChunks = [];
let recordingTimer = null;
let recordingMimeType = "video/webm";

// ======================================================
// HTML
// ======================================================

const startButton =
    document.getElementById("startButton");

const roomInput =
    document.getElementById("roomId");

const localVideo =
    document.getElementById("localVideo");

const statusText =
    document.getElementById("status");

const viewerCountText =
    document.getElementById("viewerCount");

const recordingStatusText =
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
// START CAMERA
// ======================================================

startButton.addEventListener(
    "click",
    startCamera
);

async function startCamera() {

    if (cameraStarted) {
        return;
    }

    roomId =
        roomInput.value.trim();

    if (!roomId) {

        alert("Enter a Room ID first.");

        return;
    }

    startButton.disabled = true;
    roomInput.disabled = true;

    try {

        statusText.textContent =
            "Requesting camera and microphone...";

        localStream =
            await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: "environment"
                },
                audio: true
            });

        localVideo.srcObject =
            localStream;

        localVideo.play().catch(() => {});

        cameraStarted = true;

        // ==================================================
        // START RECORDING BEFORE JOINING ROOM
        // VIEWERS ARE NOT REQUIRED
        // ==================================================

        startRecording();

        // ==================================================
        // JOIN WEBRTC ROOM
        // ==================================================

        socket.emit(
            "join-room",
            roomId
        );

        statusText.textContent =
            "🟢 Camera online";

        startButton.textContent =
            "Camera Running";

    } catch (error) {

        console.error(
            "Camera error:",
            error
        );

        statusText.textContent =
            "❌ Camera could not start";

        alert(
            error.message ||
            "Could not access the camera or microphone."
        );

        startButton.disabled = false;
        roomInput.disabled = false;
    }
}

// ======================================================
// GET SUPPORTED MIME TYPE
// ======================================================

function getRecordingMimeType() {

    const types = [
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm"
    ];

    for (const type of types) {

        if (
            MediaRecorder.isTypeSupported(type)
        ) {

            return type;
        }
    }

    return "";
}

// ======================================================
// START RECORDING
// ======================================================

function startRecording() {

    if (!localStream) {

        console.error(
            "No camera stream available."
        );

        return;
    }

    if (!window.MediaRecorder) {

        console.error(
            "MediaRecorder is not supported."
        );

        if (recordingStatusText) {
            recordingStatusText.textContent =
                "❌ Recording not supported";
        }

        return;
    }

    if (recordingTimer) {

        clearTimeout(recordingTimer);

        recordingTimer = null;
    }

    recordingChunks = [];

    const mimeType =
        getRecordingMimeType();

    recordingMimeType =
        mimeType || "video/webm";

    try {

        const options =
            mimeType
                ? { mimeType: mimeType }
                : undefined;

        mediaRecorder =
            new MediaRecorder(
                localStream,
                options
            );

        // ==================================================
        // DATA ARRIVES EVERY SECOND
        // ==================================================

        mediaRecorder.ondataavailable =
            (event) => {

                if (
                    event.data &&
                    event.data.size > 0
                ) {

                    recordingChunks.push(
                        event.data
                    );
                }
            };

        // ==================================================
        // RECORDING STARTED
        // ==================================================

        mediaRecorder.onstart =
            () => {

                console.log(
                    "🎥 Recording started."
                );

                if (recordingStatusText) {

                    recordingStatusText.textContent =
                        "🔴 Recording • Saves every 15 minutes";
                }
            };

        // ==================================================
        // RECORDING STOPPED
        // ==================================================

        mediaRecorder.onstop =
            async () => {

                console.log(
                    "⏱️ 15-minute recording finished."
                );

                const chunks =
                    recordingChunks;

                recordingChunks = [];

                if (!chunks.length) {

                    console.error(
                        "❌ No recording data was produced."
                    );

                    if (recordingStatusText) {

                        recordingStatusText.textContent =
                            "⚠️ No recording data";
                    }

                    startNextRecording();

                    return;
                }

                const blob =
                    new Blob(
                        chunks,
                        {
                            type:
                                recordingMimeType
                        }
                    );

                console.log(
                    "Recording size:",
                    blob.size,
                    "bytes"
                );

                if (recordingStatusText) {

                    recordingStatusText.textContent =
                        "☁️ Uploading to Google Drive...";
                }

                await uploadRecording(
                    blob
                );

                // Start next recording
                startNextRecording();
            };

        // ==================================================
        // RECORDING ERROR
        // ==================================================

        mediaRecorder.onerror =
            (event) => {

                console.error(
                    "❌ MediaRecorder error:",
                    event.error
                );

                if (recordingStatusText) {

                    recordingStatusText.textContent =
                        "❌ Recording error";
                }
            };

        // ==================================================
        // START RECORDING
        //
        // 1000 = dataavailable every 1 second
        // ==================================================

        mediaRecorder.start(
            RECORDING_CHUNK
        );

        // ==================================================
        // STOP AFTER 15 MINUTES
        // ==================================================

        recordingTimer =
            setTimeout(
                () => {

                    if (
                        mediaRecorder &&
                        mediaRecorder.state ===
                            "recording"
                    ) {

                        console.log(
                            "⏱️ 15 minutes reached."
                        );

                        mediaRecorder.stop();
                    }

                },
                RECORDING_LENGTH
            );

    } catch (error) {

        console.error(
            "Could not start recording:",
            error
        );

        if (recordingStatusText) {

            recordingStatusText.textContent =
                "❌ Could not start recording";
        }
    }
}

// ======================================================
// START NEXT RECORDING
// ======================================================

function startNextRecording() {

    if (
        !cameraStarted ||
        !localStream
    ) {

        return;
    }

    console.log(
        "Preparing next 15-minute recording..."
    );

    setTimeout(
        () => {

            if (
                cameraStarted &&
                localStream
            ) {

                startRecording();
            }

        },
        1000
    );
}

// ======================================================
// UPLOAD TO GOOGLE DRIVE
// ======================================================

async function uploadRecording(blob) {

    try {

        const filename =
            createRecordingFilename();

        console.log(
            "☁️ Uploading:",
            filename
        );

        const formData =
            new FormData();

        formData.append(
            "recording",
            blob,
            filename
        );

        const response =
            await fetch(
                "/upload-recording",
                {
                    method: "POST",
                    body: formData
                }
            );

        const text =
            await response.text();

        let result;

        try {

            result =
                JSON.parse(text);

        } catch {

            throw new Error(
                "Server returned an invalid response: " +
                text
            );
        }

        if (
            !response.ok ||
            !result.success
        ) {

            throw new Error(
                result.error ||
                "Upload failed."
            );
        }

        console.log(
            "✅ Uploaded to Google Drive:",
            result.fileName
        );

        if (recordingStatusText) {

            recordingStatusText.textContent =
                "🟢 Recording • Last video saved to Google Drive";
        }

    } catch (error) {

        console.error(
            "❌ Google Drive upload failed:",
            error
        );

        if (recordingStatusText) {

            recordingStatusText.textContent =
                "⚠️ Upload failed — check console";
        }
    }
}

// ======================================================
// CREATE FILE NAME
// ======================================================

function createRecordingFilename() {

    const now =
        new Date();

    const year =
        now.getFullYear();

    const month =
        String(
            now.getMonth() + 1
        ).padStart(2, "0");

    const day =
        String(
            now.getDate()
        ).padStart(2, "0");

    const hours =
        String(
            now.getHours()
        ).padStart(2, "0");

    const minutes =
        String(
            now.getMinutes()
        ).padStart(2, "0");

    const seconds =
        String(
            now.getSeconds()
        ).padStart(2, "0");

    return (
        `CCTV_${roomId}_${year}-${month}-${day}_${hours}-${minutes}-${seconds}.webm`
    );
}

// ======================================================
// CAMERA ROLE
// ======================================================

socket.on(
    "role",
    (role) => {

        if (role === "camera") {

            statusText.textContent =
                "🟢 Camera LIVE";

        }
    }
);

// ======================================================
// VIEWER JOINED
// ======================================================

socket.on(
    "viewer-joined",
    async ({ viewerId }) => {

        if (!localStream) {
            return;
        }

        console.log(
            "Viewer joined:",
            viewerId
        );

        try {

            await createConnectionForViewer(
                viewerId
            );

        } catch (error) {

            console.error(
                "Could not create viewer connection:",
                error
            );
        }
    }
);

// ======================================================
// CREATE WEBRTC CONNECTION
// ======================================================

async function createConnectionForViewer(
    viewerId
) {

    closeViewerConnection(
        viewerId
    );

    const peerConnection =
        new RTCPeerConnection(
            configuration
        );

    peerConnections.set(
        viewerId,
        peerConnection
    );

    localStream
        .getTracks()
        .forEach(
            (track) => {

                peerConnection.addTrack(
                    track,
                    localStream
                );
            }
        );

    peerConnection.onicecandidate =
        (event) => {

            if (event.candidate) {

                socket.emit(
                    "ice-candidate",
                    {
                        targetId:
                            viewerId,

                        candidate:
                            event.candidate
                    }
                );
            }
        };

    peerConnection.onconnectionstatechange =
        () => {

            console.log(
                `Viewer ${viewerId}:`,
                peerConnection.connectionState
            );
        };

    const offer =
        await peerConnection.createOffer();

    await peerConnection.setLocalDescription(
        offer
    );

    socket.emit(
        "offer",
        {
            viewerId,
            offer
        }
    );
}

// ======================================================
// ANSWER
// ======================================================

socket.on(
    "answer",
    async ({ viewerId, answer }) => {

        const peerConnection =
            peerConnections.get(
                viewerId
            );

        if (!peerConnection) {
            return;
        }

        try {

            await peerConnection.setRemoteDescription(
                new RTCSessionDescription(
                    answer
                )
            );

        } catch (error) {

            console.error(
                "Answer error:",
                error
            );
        }
    }
);

// ======================================================
// ICE
// ======================================================

socket.on(
    "ice-candidate",
    async ({
        senderId,
        candidate
    }) => {

        const peerConnection =
            peerConnections.get(
                senderId
            );

        if (!peerConnection) {
            return;
        }

        try {

            await peerConnection.addIceCandidate(
                new RTCIceCandidate(
                    candidate
                )
            );

        } catch (error) {

            console.error(
                "ICE error:",
                error
            );
        }
    }
);

// ======================================================
// VIEWER LEFT
// ======================================================

socket.on(
    "viewer-left",
    ({ viewerId }) => {

        console.log(
            "Viewer left:",
            viewerId
        );

        closeViewerConnection(
            viewerId
        );
    }
);

// ======================================================
// CLOSE VIEWER CONNECTION
// ======================================================

function closeViewerConnection(
    viewerId
) {

    const connection =
        peerConnections.get(
            viewerId
        );

    if (connection) {

        connection.close();

        peerConnections.delete(
            viewerId
        );
    }
}

// ======================================================
// VIEWER COUNT
// ======================================================

socket.on(
    "viewer-count",
    (count) => {

        viewerCountText.textContent =
            `Viewers: ${count}`;

        console.log(
            `👀 Viewers: ${count}`
        );

        // IMPORTANT:
        // Recording does NOT stop when count = 0.

        if (count === 0) {

            console.log(
                "👀 0 viewers — recording continues."
            );
        }
    }
);

// ======================================================
// SOCKET DISCONNECTED
// ======================================================

socket.on(
    "disconnect",
    () => {

        statusText.textContent =
            "⚠️ Signaling server disconnected";
    }
);

// ======================================================
// PAGE CLOSING
// ======================================================

window.addEventListener(
    "beforeunload",
    () => {

        cameraStarted = false;

        if (recordingTimer) {

            clearTimeout(
                recordingTimer
            );
        }

        if (
            mediaRecorder &&
            mediaRecorder.state ===
                "recording"
        ) {

            mediaRecorder.stop();
        }

        for (
            const connection
            of peerConnections.values()
        ) {

            connection.close();
        }

        peerConnections.clear();

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
