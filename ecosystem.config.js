export const apps = [
  {
    name: "TwitchLiveBot",
    // You can run `bun bun.ts` or compile TS first. 
    // For simplicity, let's assume you run the TS directly with Bun:
    script: "bun",
    args: ["run", "start"],
    watch: true,
    ignore_watch: ["node_modules", "dist", "logs", "app.sqlite"],
  }
];
  