const socket = io();

let roomId = "";
let localStream = null;

const peerConnections = new Map();

let cameraStarted = false;

// ======================================================
// RECORDING
// ======================================================

let mediaRecorder = null;
let recordingChunks = [];
let recordingTimer = null;

// SAVE EVERY 15 MINUTES
const RECORDING_LENGTH =
    15 * 60 * 1000; // 15 minutes

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

// ======================================================
// WEBRTC
// ======================================================

const configuration = {
    iceServers: [
        {
            urls:
                "stun:stun.l.google.com:19302"
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

        alert(
            "Enter a Room ID first."
        );

        return;
    }

    startButton.disabled = true;
    roomInput.disabled = true;

    try {

        statusText.textContent =
            "Requesting camera and microphone...";

        // GET CAMERA
        localStream =
            await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: "environment"
                },
                audio: true
            });

        localVideo.srcObject =
            localStream;

        cameraStarted = true;

        // ==================================================
        // IMPORTANT
        // RECORDING STARTS HERE
        // IT DOES NOT DEPEND ON VIEWERS
        // ==================================================

        startRecording();

        // JOIN STREAMING ROOM
        socket.emit(
            "join-room",
            roomId
        );

        statusText.textContent =
            "🟢 Camera online — recording automatically";

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

        startButton.disabled =
            false;

        roomInput.disabled =
            false;
    }
}

// ======================================================
// RECORDING MIME TYPE
// ======================================================

function getRecordingMimeType() {

    const types = [

        "video/webm;codecs=vp9,opus",

        "video/webm;codecs=vp8,opus",

        "video/webm"

    ];

    for (const type of types) {

        if (
            MediaRecorder.isTypeSupported(
                type
            )
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
            "No camera stream available for recording."
        );

        return;
    }

    if (!window.MediaRecorder) {

        console.error(
            "MediaRecorder is not supported by this browser."
        );

        return;
    }

    if (recordingTimer) {

        clearTimeout(
            recordingTimer
        );

        recordingTimer = null;
    }

    const mimeType =
        getRecordingMimeType();

    try {

        recordingChunks = [];

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
        // RECORDING DATA
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
        // RECORDING FINISHED
        // ==================================================

        mediaRecorder.onstop =
            async () => {

                console.log(
                    "15-minute recording finished."
                );

                const chunks =
                    recordingChunks;

                recordingChunks = [];

                if (
                    chunks.length === 0
                ) {

                    console.log(
                        "No recording data."
                    );

                    startNextRecording();

                    return;
                }

                const blob =
                    new Blob(
                        chunks,
                        {
                            type:
                                mediaRecorder.mimeType ||
                                "video/webm"
                        }
                    );

                console.log(
                    "Recording size:",
                    blob.size,
                    "bytes"
                );

                // UPLOAD TO GOOGLE DRIVE
                await uploadRecording(
                    blob
                );

                // START NEXT 15-MINUTE RECORDING
                startNextRecording();
            };

        // ==================================================
        // RECORDING ERROR
        // ==================================================

        mediaRecorder.onerror =
            (event) => {

                console.error(
                    "Recording error:",
                    event.error
                );
            };

        // ==================================================
        // START
        // ==================================================

        mediaRecorder.start();

        console.log(
            "🎥 Recording started."
        );

        console.log(
            "⏱️ Next save in 15 minutes."
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

                        console.log(
                            "☁️ Saving recording to Google Drive..."
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
// UPLOAD RECORDING TO GOOGLE DRIVE
// ======================================================

async function uploadRecording(
    blob
) {

    try {

        console.log(
            "☁️ Uploading recording to Google Drive..."
        );

        const formData =
            new FormData();

        const filename =
            createRecordingFilename();

        formData.append(
            "recording",
            blob,
            filename
        );

        const response =
            await fetch(
                "/upload-recording",
                {
                    method:
                        "POST",

                    body:
                        formData
                }
            );

        const result =
            await response.json();

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
            "✅ Recording uploaded successfully:"
        );

        console.log(
            result.fileName
        );

    } catch (error) {

        console.error(
            "❌ Recording upload failed:",
            error
        );
    }
}

// ======================================================
// CREATE RECORDING FILENAME
// ======================================================

function createRecordingFilename() {

    const now =
        new Date();

    const year =
        now.getFullYear();

    const month =
        String(
            now.getMonth() + 1
        ).padStart(
            2,
            "0"
        );

    const day =
        String(
            now.getDate()
        ).padStart(
            2,
            "0"
        );

    const hours =
        String(
            now.getHours()
        ).padStart(
            2,
            "0"
        );

    const minutes =
        String(
            now.getMinutes()
        ).padStart(
            2,
            "0"
        );

    const seconds =
        String(
            now.getSeconds()
        ).padStart(
            2,
            "0"
        );

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

        if (
            role === "camera"
        ) {

            statusText.textContent =
                "🟢 Camera LIVE — recording";
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

    // ADD CAMERA TRACKS
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

    // ICE CANDIDATE
    peerConnection.onicecandidate =
        (event) => {

            if (
                event.candidate
            ) {

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

    // CONNECTION STATE
    peerConnection.onconnectionstatechange =
        () => {

            console.log(
                `Viewer ${viewerId}:`,
                peerConnection.connectionState
            );
        };

    // CREATE OFFER
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
// ICE CANDIDATE
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

        if (count === 0) {

            console.log(
                "👀 No viewers. Recording continues normally."
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

        cameraStarted =
            false;

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

        // CLOSE WEBRTC CONNECTIONS
        for (
            const connection
            of peerConnections.values()
        ) {

            connection.close();
        }

        peerConnections.clear();

        // STOP CAMERA
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
