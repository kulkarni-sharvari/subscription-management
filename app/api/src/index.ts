import express from "express";
import { version } from "node:os";

const app = express();
const PORT = process.env.PORT ?? 3000;

app.get("/health", (req, resp) => {
    resp.json({status: "OK", version: "1.0"});
})

app.listen(PORT, () => {
    console.log(`API listening on http://localhost:${PORT}`)
})