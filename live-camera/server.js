const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { google } = require("googleapis");
const multer = require("multer");
const { Readable } = require("stream");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;


// ======================================================
// GOOGLE DRIVE
// ======================================================

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
);

const DRIVE_SCOPES = [
    "https://www.googleapis.com/auth/drive"
];


// ======================================================
// GOOGLE AUTHORIZATION
// ======================================================

app.get("/authorize", (req, res) => {

    const authUrl =
        oauth2Client.generateAuthUrl({

            access_type: "offline",

            scope: DRIVE_SCOPES,

            prompt: "consent"

        });

    res.redirect(authUrl);

});


app.get("/oauth2callback", async (req, res) => {

    try {

        const code =
            req.query.code;

        if (!code) {

            return res
                .status(400)
                .send(
                    "Authorization code missing."
                );

        }


        const { tokens } =
            await oauth2Client.getToken(code);


        console.log(
            "GOOGLE_REFRESH_TOKEN:",
            tokens.refresh_token
        );


        res.send(
            "Google Drive authorization successful. You can close this page."
        );


    } catch (error) {

        console.error(
            "Google OAuth error:",
            error.response?.data ||
            error.message
        );


        res
            .status(500)
            .send(
                "Google authorization failed."
            );

    }

});


// ======================================================
// GOOGLE DRIVE CLIENT
// ======================================================

function getDriveClient() {

    const refreshToken =
        process.env.GOOGLE_REFRESH_TOKEN;


    if (!refreshToken) {

        throw new Error(
            "GOOGLE_REFRESH_TOKEN is not configured."
        );

    }


    oauth2Client.setCredentials({

        refresh_token:
            refreshToken

    });


    return google.drive({

        version: "v3",

        auth:
            oauth2Client

    });

}


// ======================================================
// MULTER
// ======================================================
//
// Recordings are temporarily kept in memory.
// They are uploaded directly to Google Drive.
// ======================================================

const upload =
    multer({

        storage:
            multer.memoryStorage(),

        limits: {

            fileSize:
                500 * 1024 * 1024

        }

    });


// ======================================================
// UPLOAD RECORDING TO GOOGLE DRIVE
// ======================================================

app.post(
    "/upload-recording",
    upload.single("recording"),
    async (req, res) => {

        try {

            if (!req.file) {

                return res
                    .status(400)
                    .json({

                        success: false,

                        error:
                            "No recording received."

                    });

            }


            const folderId =
                process.env.GOOGLE_DRIVE_FOLDER_ID;


            if (!folderId) {

                return res
                    .status(500)
                    .json({

                        success: false,

                        error:
                            "GOOGLE_DRIVE_FOLDER_ID is not configured."

                    });

            }


            const drive =
                getDriveClient();


            const originalName =
                req.file.originalname ||
                `cctv-recording-${Date.now()}.webm`;


            const fileMetadata = {

                name:
                    originalName,

                parents: [
                    folderId
                ]

            };


            const media = {

                mimeType:
                    req.file.mimetype ||
                    "video/webm",

                body:
                    Readable.from(
                        req.file.buffer
                    )

            };


            const result =
                await drive.files.create({

                    requestBody:
                        fileMetadata,

                    media:
                        media,

                    fields:
                        "id,name,webViewLink"

                });


            console.log(
                "Recording uploaded:",
                result.data
            );


            res.json({

                success:
                    true,

                fileId:
                    result.data.id,

                fileName:
                    result.data.name,

                link:
                    result.data.webViewLink ||
                    null

            });


        } catch (error) {

            console.error(
                "Google Drive upload error:",
                error.response?.data ||
                error.message
            );


            res
                .status(500)
                .json({

                    success: false,

                    error:
                        "Recording upload failed."

                });

        }

    }
);


// ======================================================
// STATIC WEBSITE
// ======================================================

app.use(
    express.static(
        path.join(
            __dirname,
            "public"
        )
    )
);


app.get("/", (req, res) => {

    res.sendFile(
        path.join(
            __dirname,
            "public",
            "index.html"
        )
    );

});


// ======================================================
// ROOMS
// ======================================================
//
// Each room has:
// camera: socket ID of the camera
// viewers: Set of viewer socket IDs
//
// The server NEVER receives the live camera video.
// WebRTC sends video directly between devices.
// Recording is uploaded separately to Google Drive.
// ======================================================

const rooms =
    new Map();


function getRoom(roomId) {

    if (!rooms.has(roomId)) {

        rooms.set(
            roomId,
            {

                camera: null,

                viewers:
                    new Set()

            }
        );

    }

    return rooms.get(roomId);

}


// ======================================================
// SOCKET CONNECTION
// ======================================================

io.on(
    "connection",
    (socket) => {

        console.log(
            "Client connected:",
            socket.id
        );


        // ==================================================
        // JOIN ROOM
        // ==================================================

        socket.on(
            "join-room",
            (roomId) => {

                roomId =
                    String(
                        roomId || ""
                    ).trim();


                if (!roomId) {

                    return;

                }


                // Leave previous room if necessary

                if (
                    socket.data.roomId
                ) {

                    leaveRoom(
                        socket
                    );

                }


                socket.data.roomId =
                    roomId;


                const room =
                    getRoom(
                        roomId
                    );


                // ==================================================
                // FIRST DEVICE = CAMERA
                // ==================================================

                if (!room.camera) {

                    room.camera =
                        socket.id;


                    socket.data.role =
                        "camera";


                    socket.join(
                        roomId
                    );


                    socket.emit(
                        "role",
                        "camera"
                    );


                    socket.emit(
                        "camera-ready",
                        {

                            viewers:
                                room.viewers.size

                        }
                    );


                    console.log(
                        `Camera ${socket.id} started room ${roomId}`
                    );


                    return;

                }


                // ==================================================
                // EVERY OTHER DEVICE = VIEWER
                // ==================================================

                socket.data.role =
                    "viewer";


                room.viewers.add(
                    socket.id
                );


                socket.join(
                    roomId
                );


                socket.emit(
                    "role",
                    "viewer"
                );


                console.log(
                    `Viewer ${socket.id} joined room ${roomId}`
                );


                // Tell viewer which camera to connect to

                socket.emit(
                    "camera-available",
                    {

                        cameraId:
                            room.camera

                    }
                );


                // Tell camera that a new viewer arrived

                io.to(
                    room.camera
                ).emit(
                    "viewer-joined",
                    {

                        viewerId:
                            socket.id

                    }
                );


                // Update viewer count

                updateViewerCount(
                    roomId
                );

            }
        );


        // ==================================================
        // CAMERA OFFER -> SPECIFIC VIEWER
        // ==================================================

        socket.on(
            "offer",
            ({ viewerId, offer }) => {

                if (

                    socket.data.role !==
                        "camera" ||

                    !viewerId ||

                    !offer

                ) {

                    return;

                }


                io.to(
                    viewerId
                ).emit(
                    "offer",
                    {

                        cameraId:
                            socket.id,

                        offer

                    }
                );

            }
        );


        // ==================================================
        // VIEWER ANSWER -> CAMERA
        // ==================================================

        socket.on(
            "answer",
            ({ cameraId, answer }) => {

                if (

                    socket.data.role !==
                        "viewer" ||

                    !cameraId ||

                    !answer

                ) {

                    return;

                }


                io.to(
                    cameraId
                ).emit(
                    "answer",
                    {

                        viewerId:
                            socket.id,

                        answer

                    }
                );

            }
        );


        // ==================================================
        // ICE CANDIDATE
        // ==================================================

        socket.on(
            "ice-candidate",
            ({ targetId, candidate }) => {

                if (

                    !targetId ||

                    !candidate

                ) {

                    return;

                }


                io.to(
                    targetId
                ).emit(
                    "ice-candidate",
                    {

                        senderId:
                            socket.id,

                        candidate

                    }
                );

            }
        );


        // ==================================================
        // DISCONNECT
        // ==================================================

        socket.on(
            "disconnect",
            () => {

                console.log(
                    "Client disconnected:",
                    socket.id
                );


                leaveRoom(
                    socket
                );

            }
        );

    }
);


// ======================================================
// LEAVE ROOM
// ======================================================

function leaveRoom(socket) {

    const roomId =
        socket.data.roomId;


    if (!roomId) {

        return;

    }


    const room =
        rooms.get(
            roomId
        );


    if (!room) {

        return;

    }


    // ==================================================
    // CAMERA LEFT
    // ==================================================

    if (

        socket.data.role ===
            "camera" &&

        room.camera ===
            socket.id

    ) {

        room.camera =
            null;


        // Tell all viewers that camera is gone

        for (
            const viewerId
            of room.viewers
        ) {

            io.to(
                viewerId
            ).emit(
                "camera-left"
            );

        }


        console.log(
            `Camera left room ${roomId}`
        );

    }


    // ==================================================
    // VIEWER LEFT
    // ==================================================

    if (
        socket.data.role ===
            "viewer"
    ) {

        room.viewers.delete(
            socket.id
        );


        // Tell camera this viewer is gone

        if (
            room.camera
        ) {

            io.to(
                room.camera
            ).emit(
                "viewer-left",
                {

                    viewerId:
                        socket.id

                }
            );

        }


        console.log(
            `Viewer left room ${roomId}`
        );

    }


    socket.leave(
        roomId
    );


    socket.data.roomId =
        null;


    socket.data.role =
        null;


    updateViewerCount(
        roomId
    );


    // Remove empty room

    if (

        !room.camera &&

        room.viewers.size === 0

    ) {

        rooms.delete(
            roomId
        );


        console.log(
            `Room deleted: ${roomId}`
        );

    }

}


// ======================================================
// VIEWER COUNT
// ======================================================

function updateViewerCount(roomId) {

    const room =
        rooms.get(
            roomId
        );


    if (!room) {

        return;

    }


    const count =
        room.viewers.size;


    if (room.camera) {

        io.to(
            room.camera
        ).emit(
            "viewer-count",
            count
        );

    }


    for (
        const viewerId
        of room.viewers
    ) {

        io.to(
            viewerId
        ).emit(
            "viewer-count",
            count
        );

    }

}


// ======================================================
// HEALTH
// ======================================================

app.get(
    "/health",
    (req, res) => {

        res.json({

            ok:
                true,

            streaming:
                true,

            recording:
                true,

            storage:
                true

        });

    }
);


// ======================================================
// START
// ======================================================

server.listen(
    PORT,
    () => {

        console.log(
            `Live camera server running on port ${PORT}`
        );

        console.log(
            "Video recording: ENABLED"
        );

        console.log(
            "Google Drive upload: ENABLED"
        );

    }
);
