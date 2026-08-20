const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { google } = require("googleapis");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// ======================================================
// MIDDLEWARE
// ======================================================

app.use(express.json({ limit: "2mb" }));

// Raw video chunks for the Google Drive proxy
app.use(
  "/api/drive/chunk",
  express.raw({
    type: "application/octet-stream",
    limit: "20mb"
  })
);

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

// ======================================================
// GOOGLE DRIVE AUTHENTICATION
// ======================================================

function getDrive() {
  const credential =
    process.env.GOOGLE_FILE_CREDENTIAL;

  if (!credential) {
    throw new Error(
      "Google Drive credentials are not configured."
    );
  }

  let credentials;

  try {
    credentials = JSON.parse(credential);
  } catch (error) {
    throw new Error(
      "GOOGLE_FILE_CREDENTIAL is not valid JSON."
    );
  }

  if (
    !credentials.client_email ||
    !credentials.private_key ||
    !credentials.project_id
  ) {
    throw new Error(
      "Google service-account JSON is missing required fields."
    );
  }

  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key.replace(
      /\\n/g,
      "\n"
    ),
    scopes: [
      "https://www.googleapis.com/auth/drive"
    ]
  });

  return google.drive({
    version: "v3",
    auth
  });
}

// ======================================================
// SAFE FILE NAME
// ======================================================

function safeName(name) {
  return String(
    name || "recording.webm"
  )
    .replace(
      /[^a-zA-Z0-9._ -]/g,
      "_"
    )
    .slice(0, 180);
}

// ======================================================
// STORE ACTIVE UPLOAD SESSIONS
// ======================================================

const uploadSessions = new Map();

// ======================================================
// CREATE GOOGLE DRIVE UPLOAD SESSION
// ======================================================

app.post(
  "/api/drive/session",
  async (req, res) => {

    try {

      const folderId =
        process.env.GOOGLE_DRIVE_FOLDER_ID;

      if (!folderId) {
        return res.status(500).json({
          error:
            "GOOGLE_DRIVE_FOLDER_ID is not configured."
        });
      }

      const drive = getDrive();

      const auth =
        drive.context._options.auth;

      const tokenResponse =
        await auth.getAccessToken();

      const token =
        typeof tokenResponse === "string"
          ? tokenResponse
          : tokenResponse.token;

      if (!token) {
        throw new Error(
          "Could not obtain Google Drive access token."
        );
      }

      const mime =
        req.body.mimeType ||
        "video/webm";

      const metadata = {
        name: safeName(
          req.body.fileName
        ),
        parents: [folderId],
        mimeType: mime
      };

      const response =
        await fetch(
          "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",
          {
            method: "POST",

            headers: {
              Authorization:
                `Bearer ${token}`,

              "Content-Type":
                "application/json; charset=UTF-8",

              "X-Upload-Content-Type":
                mime
            },

            body:
              JSON.stringify(metadata)
          }
        );

      if (!response.ok) {

        const text =
          await response.text();

        throw new Error(
          `Drive session failed: ${response.status} ${text}`
        );
      }

      const uploadUrl =
        response.headers.get(
          "location"
        );

      if (!uploadUrl) {
        throw new Error(
          "Google Drive did not return an upload URL."
        );
      }

      // Create our own session ID.
      // The browser never needs to directly
      // communicate with Google.

      const sessionId =
        crypto.randomUUID();

      uploadSessions.set(
        sessionId,
        {
          uploadUrl,
          mime,
          createdAt: Date.now()
        }
      );

      console.log(
        "Google Drive upload session created:",
        sessionId
      );

      res.json({
        sessionId
      });

    } catch (error) {

      console.error(
        "Google Drive session error:",
        error
      );

      res.status(500).json({
        error: error.message
      });
    }
  }
);

// ======================================================
// PROXY VIDEO CHUNK TO GOOGLE DRIVE
// ======================================================

app.post(
  "/api/drive/chunk",
  async (req, res) => {

    try {

      const sessionId =
        req.headers["x-upload-session"];

      if (!sessionId) {
        return res.status(400).json({
          error:
            "Upload session is missing."
        });
      }

      const session =
        uploadSessions.get(sessionId);

      if (!session) {
        return res.status(404).json({
          error:
            "Upload session not found or expired."
        });
      }

      if (
        !req.body ||
        !Buffer.isBuffer(req.body) ||
        req.body.length === 0
      ) {
        return res.status(400).json({
          error:
            "No video data received."
        });
      }

      const contentRange =
        req.headers["content-range"];

      if (!contentRange) {
        return res.status(400).json({
          error:
            "Content-Range header is missing."
        });
      }

      console.log(
        "Proxying chunk:",
        contentRange,
        "size:",
        req.body.length
      );

      const googleResponse =
        await fetch(
          session.uploadUrl,
          {
            method: "PUT",

            headers: {
              "Content-Type":
                session.mime,

              "Content-Range":
                contentRange
            },

            body: req.body
          }
        );

      const responseText =
        await googleResponse.text();

      // Forward Google's Range header
      // back to the browser.

      const range =
        googleResponse.headers.get(
          "Range"
        );

      if (range) {
        res.setHeader(
          "Range",
          range
        );
      }

      // ==================================================
      // UPLOAD COMPLETE
      // ==================================================

      if (
        googleResponse.status === 200 ||
        googleResponse.status === 201
      ) {

        console.log(
          "Google Drive file upload completed."
        );

        uploadSessions.delete(
          sessionId
        );

        return res.status(
          googleResponse.status
        ).send(responseText);
      }

      // ==================================================
      // MORE DATA REQUIRED
      // ==================================================

      if (
        googleResponse.status === 308
      ) {

        return res.status(308).send();
      }

      // ==================================================
      // GOOGLE ERROR
      // ==================================================

      console.error(
        "Google Drive chunk error:",
        googleResponse.status,
        responseText
      );

      return res
        .status(
          googleResponse.status
        )
        .send(responseText);

    } catch (error) {

      console.error(
        "Chunk proxy error:",
        error
      );

      res.status(500).json({
        error: error.message
      });
    }
  }
);

// ======================================================
// 30-DAY CLEANUP
// ======================================================

app.post(
  "/api/cleanup",
  async (req, res) => {

    try {

      const cleanupToken =
        process.env.CLEANUP_TOKEN;

      if (
        !cleanupToken ||
        req.headers.authorization !==
          `Bearer ${cleanupToken}`
      ) {
        return res.status(401).json({
          error: "Unauthorized"
        });
      }

      const folderId =
        process.env.GOOGLE_DRIVE_FOLDER_ID;

      if (!folderId) {
        return res.status(500).json({
          error:
            "Folder ID not configured."
        });
      }

      const drive =
        getDrive();

      const cutoff =
        new Date(
          Date.now() -
          30 *
          24 *
          60 *
          60 *
          1000
        ).toISOString();

      let deleted = 0;
      let pageToken;

      do {

        const result =
          await drive.files.list({
            q:
              `'${folderId}' in parents ` +
              `and trashed = false ` +
              `and createdTime < '${cutoff}'`,

            fields:
              "nextPageToken, files(id,name,createdTime)",

            pageSize: 1000,

            pageToken
          });

        for (
          const file of
          result.data.files || []
        ) {

          console.log(
            "Deleting old recording:",
            file.name
          );

          await drive.files.update({
            fileId: file.id,

            requestBody: {
              trashed: true
            }
          });

          deleted++;
        }

        pageToken =
          result.data.nextPageToken;

      } while (pageToken);

      res.json({
        ok: true,
        deleted
      });

    } catch (error) {

      console.error(
        "Cleanup error:",
        error
      );

      res.status(500).json({
        error: error.message
      });
    }
  }
);

// ======================================================
// HEALTH CHECK
// ======================================================

app.get(
  "/health",
  (req, res) => {

    res.json({
      ok: true,

      googleDriveConfigured:
        !!process.env
          .GOOGLE_FILE_CREDENTIAL,

      folderConfigured:
        !!process.env
          .GOOGLE_DRIVE_FOLDER_ID
    });
  }
);

// ======================================================
// SOCKET.IO LIVE STREAM
// ======================================================

io.on(
  "connection",
  socket => {

    socket.on(
      "join-room",
      roomId => {

        socket.join(roomId);

        const room =
          io.sockets.adapter
            .rooms
            .get(roomId);

        const users =
          room
            ? room.size
            : 0;

        socket.emit(
          "role",
          users === 1
            ? "camera"
            : "viewer"
        );

        socket
          .to(roomId)
          .emit(
            "user-joined"
          );
      }
    );

    socket.on(
      "offer",
      ({ roomId, offer }) => {

        socket
          .to(roomId)
          .emit(
            "offer",
            offer
          );
      }
    );

    socket.on(
      "answer",
      ({ roomId, answer }) => {

        socket
          .to(roomId)
          .emit(
            "answer",
            answer
          );
      }
    );

    socket.on(
      "ice-candidate",
      ({ roomId, candidate }) => {

        socket
          .to(roomId)
          .emit(
            "ice-candidate",
            candidate
          );
      }
    );
  }
);

// ======================================================
// START SERVER
// ======================================================

server.listen(
  PORT,
  () => {

    console.log(
      `Server running on port ${PORT}`
    );

    console.log(
      `Google Drive credential configured: ${
        !!process.env
          .GOOGLE_FILE_CREDENTIAL
      }`
    );

    console.log(
      `Google Drive folder configured: ${
        !!process.env
          .GOOGLE_DRIVE_FOLDER_ID
      }`
    );
  }
);
