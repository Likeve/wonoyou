import { createCloudApp } from "./cloud-app.js";
import { resolve } from "node:path";
const { server } = createCloudApp({ staticDir: resolve("dist") });
const port = Number(process.env.PORT || 8788);
server.listen(port, "127.0.0.1", () => console.log(`INOU Redis backend at http://localhost:${port}`));
