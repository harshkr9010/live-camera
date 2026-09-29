const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const { google } = require("googleapis");
const multer = require("multer");
const { Readable } = require("stream");

const app = express();
const server = http.createServer(app);
const io = new Server(server);


// ======================================================
// GOOGLE DRIVE
// ======================================================

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
);

const GOOGLE_SCOPES = [
    "https://www.googleapis.com/auth/drive"
];


// ======================================================
// GOOGLE AUTHORIZATION
// ======================================================

app.get("/authorize", (req, res) => {

    const authUrl =
        oauth2Client.generateAuthUrl({
            access_type: "offline",
            prompt: "consent",
            scope: GOOGLE_SCOPES
        });

    res.redirect(authUrl);

});


app.get("/oauth2callback", async (req, res) => {

    try {

        const { code } = req.query;

        const { tokens } =
            await oauth2Client.getToken(code);

        console.log(
            "Google OAuth completed."
        );

        console.log(
            "Refresh token received. Add it to Render as GOOGLE_REFRESH_TOKEN."
        );

        res.send(
            "Google Drive authorization successful. You can close this page."
        );

    } catch (error) {

        console.error(
            "Google OAuth error:",
            error
        );

        res.status(500).send(
            "Google authorization failed."
        );

    }

});


// ======================================================
// GOOGLE DRIVE CLIENT
// ======================================================

function getDriveClient() {

    oauth2Client.setCredentials({

        refresh_token:
            process.env.GOOGLE_REFRESH_TOKEN

    });

    return google.drive({
        version: "v3",
        auth: oauth2Client
    });

}


// ======================================================
// MULTER
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

                return res.status(400).json({

                    success: false,

                    error:
                        "No recording received."

                });

            }


            if (
                !process.env.GOOGLE_DRIVE_FOLDER_ID
            ) {

                return res.status(500).json({

                    success: false,

                    error:
                        "Google Drive folder ID is not configured."

                });

            }


            const drive =
                getDriveClient();


            const fileMetadata = {

                name:
                    req.file.originalname,

                parents: [
                    process.env.GOOGLE_DRIVE_FOLDER_ID
                ],

                mimeType:
                    "video/webm"

            };


            const media = {

                mimeType:
                    "video/webm",

                body:
                    Readable.from(
                        req.file.buffer
                    )

            };


            console.log(
                "Uploading recording:",
                req.file.originalname
            );


            const file =
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
                file.data.name
            );


            res.json({

                success: true,

                fileId:
                    file.data.id,

                fileName:
                    file.data.name,

                link:
                    file.data.webViewLink || null

            });


        } catch (error) {

            console.error(
                "Google Drive upload error:",
                error
            );


            res.status(500).json({

                success: false,

                error:
                    "Google Drive upload failed."

            });

        }

    }
);


// ======================================================
// WEBSITE
// ======================================================

app.use(
    express.static("public")
);


app.get(
    "/",
    (req, res) => {

        res.sendFile(
            __dirname +
            "/public/index.html"
        );

    }
);


// ======================================================
// CCTV ROOMS
// ======================================================

const rooms =
    new Map();


/*

Room structure:

{
    camera: socketId,
    viewers: Set()
}

*/


// ======================================================
// JOIN ROOM
// ======================================================

io.on(
    "connection",
    (socket) => {

        console.log(
            "Socket connected:",
            socket.id
        );


        socket.on(
            "join-room",
            (roomId) => {

                if (!roomId) {
                    return;
                }


                socket.roomId =
                    roomId;


                if (!rooms.has(roomId)) {

                    rooms.set(
                        roomId,
                        {

                            camera:
                                null,

                            viewers:
                                new Set()

                        }
                    );

                }


                const room =
                    rooms.get(roomId);


                // ==========================================
                // FIRST USER = CAMERA
                // ==========================================

                if (!room.camera) {

                    room.camera =
                        socket.id;


                    socket.role =
                        "camera";


                    socket.join(
                        roomId
                    );


                    socket.emit(
                        "role",
                        "camera"
                    );


                    socket.emit(
                        "camera-ready"
                    );


                    console.log(
                        `Camera joined room ${roomId}`
                    );


                    updateViewerCount(
                        roomId
                    );


                    return;

                }


                // ==========================================
                // OTHER USERS = VIEWERS
                // ==========================================

                room.viewers.add(
                    socket.id
                );


                socket.role =
                    "viewer";


                socket.join(
                    roomId
                );


                socket.emit(
                    "role",
                    "viewer"
                );


                socket.emit(
                    "camera-available",
                    {

                        cameraId:
                            room.camera

                    }
                );


                io.to(
                    room.camera
                ).emit(
                    "viewer-joined",
                    {

                        viewerId:
                            socket.id

                    }
                );


                updateViewerCount(
                    roomId
                );


                console.log(
                    `Viewer ${socket.id} joined room ${roomId}`
                );

            }
        );


        // ==================================================
        // OFFER
        // ==================================================

        socket.on(
            "offer",
            ({
                viewerId,
                offer
            }) => {

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
        // ANSWER
        // ==================================================

        socket.on(
            "answer",
            ({
                cameraId,
                answer
            }) => {

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
            ({
                targetId,
                candidate
            }) => {

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
                    "Socket disconnected:",
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
// UPDATE VIEWER COUNT
// ======================================================

function updateViewerCount(
    roomId
) {

    const room =
        rooms.get(roomId);


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


    room.viewers.forEach(
        (viewerId) => {

            io.to(
                viewerId
            ).emit(
                "viewer-count",
                count
            );

        }
    );

}


// ======================================================
// LEAVE ROOM
// ======================================================

function leaveRoom(
    socket
) {

    const roomId =
        socket.roomId;


    if (!roomId) {
        return;
    }


    const room =
        rooms.get(roomId);


    if (!room) {
        return;
    }


    // ==========================================
    // CAMERA LEFT
    // ==========================================

    if (
        room.camera ===
        socket.id
    ) {

        room.camera =
            null;


        room.viewers.forEach(
            (viewerId) => {

                io.to(
                    viewerId
                ).emit(
                    "camera-left"
                );

            }
        );


        room.viewers.clear();


        console.log(
            `Camera left room ${roomId}`
        );

    }


    // ==========================================
    // VIEWER LEFT
    // ==========================================

    else if (
        room.viewers.has(
            socket.id
        )
    ) {

        room.viewers.delete(
            socket.id
        );


        if (room.camera) {

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


    updateViewerCount(
        roomId
    );


    // ==========================================
    // DELETE EMPTY ROOM
    // ==========================================

    if (
        !room.camera &&
        room.viewers.size === 0
    ) {

        rooms.delete(
            roomId
        );

    }

}


// ======================================================
// HEALTH CHECK
// ======================================================

app.get(
    "/health",
    (req, res) => {

        res.json({

            ok: true,

            streaming: true,

            recording: true,

            storage: true

        });

    }
);


// ======================================================
// START SERVER
// ======================================================

const PORT =
    process.env.PORT || 3000;


server.listen(
    PORT,
    () => {

        console.log(
            `Server running on port ${PORT}`
        );

        console.log(
            "Google Drive recording upload enabled."
        );

    }
);
