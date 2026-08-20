import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const app = express();
app.use(express.json());

async function getEbayToken() {
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("eBay credentials are not configured.");
  }

  const credentials = Buffer.from(
    `${clientId}:${clientSecret}`
  ).toString("base64");

  const response = await fetch(
    "https://api.ebay.com/identity/v1/oauth2/token",
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: "https://api.ebay.com/oauth/api_scope"
      })
    }
  );

  if (!response.ok) {
    throw new Error(`eBay sign-in failed: ${response.status}`);
  }

  return (await response.json()).access_token;
}

async function findItem(itemId, marketplaceId) {
  const token = await getEbayToken();
  const numericId = /^\d+$/.test(itemId);

  const url = numericId
    ? `https://api.ebay.com/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=${encodeURIComponent(itemId)}`
    : `https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(itemId)}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": marketplaceId
    }
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.errors?.[0]?.message || `eBay lookup failed: ${response.status}`
    );
  }

  return {
    itemId: data.itemId,
    legacyItemId: data.legacyItemId,
    title: data.title,
    price: data.price,
    buyingOptions: data.buyingOptions,
    estimatedAvailabilities: data.estimatedAvailabilities,
    itemEndDate: data.itemEndDate,
    itemWebUrl: data.itemWebUrl,
    seller: data.seller
      ? {
          username: data.seller.username,
          feedbackPercentage: data.seller.feedbackPercentage
        }
      : null
  };
}

function createServer() {
  const server = new McpServer({
    name: "eBay Browse Connector",
    version: "1.0.0"
  });

  server.registerTool(
    "lookup_ebay_item",
    {
      title: "Look up an eBay item",
      description:
        "Look up a public eBay listing and return its availability details.",
      inputSchema: {
        itemId: z.string().describe("The eBay item number or REST item ID"),
        marketplaceId: z.string().default("EBAY_US")
      }
    },
    async ({ itemId, marketplaceId }) => {
      try {
        const item = await findItem(itemId.trim(), marketplaceId);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(item, null, 2)
            }
          ],
          structuredContent: item
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error.message }]
        };
      }
    }
  );

  return server;
}

app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "eBay Browse MCP" });
});

app.post("/mcp", async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error(error);

    if (!res.headersSent) {
      res.status(500).json({ error: "MCP request failed" });
    }
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`eBay Browse MCP running on port ${port}`);
});
