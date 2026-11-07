import { createCloudApp } from "../server/cloud-app.js";

// No filesystem database or listen() inside a Vercel Function.
const { server } = createCloudApp();
export default server;
