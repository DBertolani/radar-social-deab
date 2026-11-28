const fs = require("fs");
const path = require("path");

module.exports = function handler(req, res) {
  const host = String(
    req.headers["x-forwarded-host"] || req.headers.host || ""
  ).toLowerCase();

  const fileName = host.includes("bio.deab.com.br")
    ? "bio-home.html"
    : "radar.html";

  const filePath = path.join(process.cwd(), fileName);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Vary", "Host");

  fs.readFile(filePath, "utf8", (error, html) => {
    if (error) {
      console.error("[api/root] Falha ao carregar " + fileName, error);
      res.statusCode = 500;
      res.end("Não foi possível carregar a página solicitada.");
      return;
    }

    res.statusCode = 200;
    res.end(html);
  });
};
