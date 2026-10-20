import { slackChannel } from "eve/channels/slack";

// Slack channel for dazl GTM agent.
// Setup: set SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET in your environment.
// Then configure Slack app event subscriptions to POST to:
//   https://your-agent.example.com/eve/v1/slack
// Subscribe to: app_mention, message.im
// Required scopes: app_mentions:read, chat:write, im:history
export default slackChannel({
  credentials: {
    botToken: process.env["SLACK_BOT_TOKEN"] ?? "",
    signingSecret: process.env["SLACK_SIGNING_SECRET"] ?? "",
  },
});
