const fs = require("fs");
const readline = require("readline");
const { google } = require("googleapis");

const credentials = JSON.parse(
    fs.readFileSync("google-credentials.json", "utf8")
);

const config =
    credentials.web || credentials.installed;

const oauth2Client = new google.auth.OAuth2(
    config.client_id,
    config.client_secret,
    "http://localhost:3000/oauth2callback"
);

const SCOPES = [
    "https://www.googleapis.com/auth/drive"
];

const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent"
});

console.log("\nOpen this URL in your browser:\n");
console.log(authUrl);
console.log("\nAfter you authorize Google, copy the code from the browser.\n");

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

rl.question("Paste the authorization code here: ", async (code) => {

    try {

        const { tokens } =
            await oauth2Client.getToken(code);

        console.log("\n=================================");
        console.log("REFRESH TOKEN:");
        console.log("=================================\n");

        console.log(tokens.refresh_token);

        console.log("\n=================================");
        console.log("Keep this token private.");
        console.log("=================================\n");

    } catch (error) {

        console.error(
            "\nCould not get token:",
            error.response?.data || error.message
        );

    }

    rl.close();

});
