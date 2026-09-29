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

const RECORDING_LENGTH =
    2 * 60 * 1000; // 2 minutes


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


        // ==================================================
        // CAMERA + MICROPHONE
        // ==================================================

        localStream =
            await navigator
                .mediaDevices
                .getUserMedia({

                    video: {
                        facingMode: "environment"
                    },

                    audio: true

                });


        localVideo.srcObject =
            localStream;


        cameraStarted = true;


        // ==================================================
        // JOIN ROOM
        // ==================================================

        socket.emit(
            "join-room",
            roomId
        );


        statusText.textContent =
            "🟢 Camera online — waiting for viewers";


        startButton.textContent =
            "Camera Running";


        // ==================================================
        // START RECORDING
        // ==================================================

        startRecording();


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


    for (
        const type
        of types
    ) {

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
        return;
    }


    if (
        !window.MediaRecorder
    ) {

        console.error(
            "MediaRecorder is not supported."
        );

        return;

    }


    const mimeType =
        getRecordingMimeType();


    try {

        recordingChunks = [];


        const options =
            mimeType
                ? {
                    mimeType
                }
                : undefined;


        mediaRecorder =
            new MediaRecorder(
                localStream,
                options
            );


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


        mediaRecorder.onstop =
            async () => {

                const chunks =
                    recordingChunks;


                recordingChunks = [];


                if (
                    chunks.length === 0
                ) {

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
                    "Recording finished:",
                    blob.size,
                    "bytes"
                );


                await uploadRecording(
                    blob
                );


                startNextRecording();

            };


        mediaRecorder.onerror =
            (event) => {

                console.error(
                    "Recording error:",
                    event.error
                );

            };


        mediaRecorder.start();


        console.log(
            "Recording started"
        );


        recordingTimer =
            setTimeout(
                () => {

                    if (
                        mediaRecorder &&
                        mediaRecorder.state ===
                            "recording"
                    ) {

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
// UPLOAD RECORDING
// ======================================================

async function uploadRecording(
    blob
) {

    try {

        console.log(
            "Uploading recording to Google Drive..."
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
            "Recording uploaded to Google Drive:",
            result.fileName
        );


    } catch (error) {

        console.error(
            "Recording upload failed:",
            error
        );

    }

}


// ======================================================
// RECORDING FILE NAME
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
                "🟢 Camera LIVE — waiting for viewers";

        }

    }
);


// ======================================================
// NEW VIEWER
// ======================================================

socket.on(
    "viewer-joined",
    async ({ viewerId }) => {

        if (!localStream) {
            return;
        }


        console.log(
            "New viewer:",
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
// CREATE CONNECTION FOR ONE VIEWER
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


    // ==================================================
    // SEND CAMERA TRACKS
    // ==================================================

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


    // ==================================================
    // ICE
    // ==================================================

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


    // ==================================================
    // CONNECTION STATE
    // ==================================================

    peerConnection.onconnectionstatechange =
        () => {

            console.log(
                `Viewer ${viewerId} connection:`,
                peerConnection.connectionState
            );


            if (
                peerConnection.connectionState ===
                    "connected"
            ) {

                statusText.textContent =
                    "🔴 LIVE";

            }

        };


    // ==================================================
    // CREATE OFFER
    // ==================================================

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


    console.log(
        "Offer sent to viewer:",
        viewerId
    );

}


// ======================================================
// RECEIVE ANSWER
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


            console.log(
                "Answer received from:",
                viewerId
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

    }
);


// ======================================================
// SOCKET DISCONNECT
// ======================================================

socket.on(
    "disconnect",
    () => {

        statusText.textContent =
            "⚠️ Signaling server disconnected";

    }
);


// ======================================================
// PAGE CLOSE
// ======================================================

window.addEventListener(
    "beforeunload",
    () => {

        cameraStarted =
            false;


        if (
            recordingTimer
        ) {

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
