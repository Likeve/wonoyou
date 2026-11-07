import { createApp } from "./app.js";
const { server } = createApp();
server.listen(Number(process.env.PORT || 8787), "0.0.0.0", () =>
  console.log(`INOU running at http://localhost:${process.env.PORT || 8787}`),
);
