import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const EBAY_SCOPE = "https://api.ebay.com/oauth/api_scope";
const DEFAULT_MARKETPLACE = "EBAY_US";
const REQUEST_TIMEOUT_MS = 15_000;

let tokenCache = {
  accessToken: null,
  expiresAt: 0
};

const priceSchema = z.object({
  value: z.string(),
  currency: z.string()
});

const availabilitySchema = z.object({
  deliveryOptions: z.array(z.string()).optional(),
  availabilityThreshold: z.number().optional(),
  availabilityThresholdType: z.string().optional(),
  estimatedAvailabilityStatus: z.string().optional(),
  estimatedAvailableQuantity: z.number().optional(),
  estimatedSoldQuantity: z.number().optional()
});

const sellerSchema = z.object({
  username: z.string().optional(),
  feedbackPercentage: z.string().optional(),
  feedbackScore: z.number().optional()
});

const itemOutputSchema = z.object({
  requestedItemId: z.string(),
  itemId: z.string().optional(),
  legacyItemId: z.string().optional(),
  title: z.string().optional(),
  shortDescription: z.string().optional(),
  price: priceSchema.optional(),
  buyingOptions: z.array(z.string()),
  estimatedAvailabilities: z.array(availabilitySchema),
  availabilityStatus: z.enum([
    "IN_STOCK",
    "OUT_OF_STOCK",
    "ENDED",
    "UNKNOWN"
  ]),
  publicQuantityAvailable: z.number().nullable(),
  quantityIsEstimated: z.boolean(),
  itemEndDate: z.string().optional(),
  itemWebUrl: z.string().optional(),
  condition: z.string().optional(),
  conditionId: z.string().optional(),
  categoryPath: z.string().optional(),
  enabledForGuestCheckout: z.boolean().optional(),
  seller: sellerSchema.nullable(),
  marketplaceId: z.string()
});

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("The eBay request timed out.");
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonResponse(response) {
  const text = await response.text();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `eBay returned an invalid response (HTTP ${response.status}).`
    );
  }
}

function getEbayApiError(data, status) {
  const ebayError = data?.errors?.[0];

  if (ebayError) {
    const details = Array.isArray(ebayError.parameters)
      ? ebayError.parameters
          .map(({ name, value }) => `${name}: ${value}`)
          .join(", ")
      : "";

    return [
      ebayError.message,
      ebayError.longMessage,
      details
    ]
      .filter(Boolean)
      .join(" — ");
  }

  if (status === 404) {
    return "The eBay listing was not found.";
  }

  return `eBay request failed with HTTP ${status}.`;
}

async function getEbayToken() {
  const now = Date.now();

  if (
    tokenCache.accessToken &&
    tokenCache.expiresAt > now + 60_000
  ) {
    return tokenCache.accessToken;
  }

  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "EBAY_CLIENT_ID and EBAY_CLIENT_SECRET must be configured."
    );
  }

  const credentials = Buffer.from(
    `${clientId}:${clientSecret}`
  ).toString("base64");

  const response = await fetchWithTimeout(
    "https://api.ebay.com/identity/v1/oauth2/token",
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: EBAY_SCOPE
      })
    }
  );

  const data = await readJsonResponse(response);

  if (!response.ok || !data.access_token) {
    throw new Error(getEbayApiError(data, response.status));
  }

  const expiresInSeconds = Number(data.expires_in) || 7200;

  tokenCache = {
    accessToken: data.access_token,
    expiresAt: now + expiresInSeconds * 1000
  };

  return tokenCache.accessToken;
}

function buildItemUrl(itemId) {
  if (/^\d+$/.test(itemId)) {
    const params = new URLSearchParams({
      legacy_item_id: itemId
    });

    return (
      "https://api.ebay.com/buy/browse/v1/item/" +
      `get_item_by_legacy_id?${params.toString()}`
    );
  }

  return (
    "https://api.ebay.com/buy/browse/v1/item/" +
    encodeURIComponent(itemId)
  );
}

function determineAvailability(data) {
  const availabilities = Array.isArray(data.estimatedAvailabilities)
    ? data.estimatedAvailabilities
    : [];

  const statuses = availabilities
    .map((entry) => entry.estimatedAvailabilityStatus)
    .filter(Boolean);

  const quantities = availabilities
    .map((entry) => entry.estimatedAvailableQuantity)
    .filter((quantity) => Number.isFinite(quantity));

  if (statuses.includes("OUT_OF_STOCK")) {
    return {
      availabilityStatus: "OUT_OF_STOCK",
      publicQuantityAvailable: 0,
      quantityIsEstimated: true
    };
  }

  if (statuses.includes("IN_STOCK") || quantities.some((q) => q > 0)) {
    return {
      availabilityStatus: "IN_STOCK",
      publicQuantityAvailable:
        quantities.length === 1 ? quantities[0] : null,
      quantityIsEstimated: quantities.length > 0
    };
  }

  if (
    data.itemEndDate &&
    new Date(data.itemEndDate).getTime() < Date.now()
  ) {
    return {
      availabilityStatus: "ENDED",
      publicQuantityAvailable: null,
      quantityIsEstimated: false
    };
  }

  if (
    Array.isArray(data.buyingOptions) &&
    data.buyingOptions.length > 0
  ) {
    return {
      availabilityStatus: "IN_STOCK",
      publicQuantityAvailable: null,
      quantityIsEstimated: false
    };
  }

  return {
    availabilityStatus: "UNKNOWN",
    publicQuantityAvailable: null,
    quantityIsEstimated: false
  };
}

async function findItem(itemId, marketplaceId) {
  const token = await getEbayToken();
  const response = await fetchWithTimeout(buildItemUrl(itemId), {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": marketplaceId,
      Accept: "application/json"
    }
  });

  const data = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(getEbayApiError(data, response.status));
  }

  const availability = determineAvailability(data);

  return itemOutputSchema.parse({
    requestedItemId: itemId,
    itemId: data.itemId,
    legacyItemId: data.legacyItemId,
    title: data.title,
    shortDescription: data.shortDescription,
    price: data.price,
    buyingOptions: data.buyingOptions ?? [],
    estimatedAvailabilities: data.estimatedAvailabilities ?? [],
    ...availability,
    itemEndDate: data.itemEndDate,
    itemWebUrl: data.itemWebUrl,
    condition: data.condition,
    conditionId: data.conditionId,
    categoryPath: data.categoryPath,
    enabledForGuestCheckout: data.enabledForGuestCheckout,
    seller: data.seller
      ? {
          username: data.seller.username,
          feedbackPercentage: data.seller.feedbackPercentage,
          feedbackScore: data.seller.feedbackScore
        }
      : null,
    marketplaceId
  });
}

function createServer() {
  const server = new McpServer({
    name: "eBay Browse Connector",
    version: "1.1.0"
  });

  server.registerTool(
    "lookup_ebay_item",
    {
      title: "Look up an eBay item",
      description:
        "Look up a public eBay listing and return its current public availability details.",
      inputSchema: {
        itemId: z
          .string()
          .trim()
          .min(1)
          .describe("The eBay item number or REST item ID"),
        marketplaceId: z
          .string()
          .trim()
          .min(1)
          .default(DEFAULT_MARKETPLACE)
          .describe("The eBay marketplace, such as EBAY_US")
      },
      outputSchema: itemOutputSchema
    },
    async ({ itemId, marketplaceId }) => {
      try {
        const normalizedMarketplace = marketplaceId.toUpperCase();
        const item = await findItem(
          itemId.trim(),
          normalizedMarketplace
        );

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
          content: [
            {
              type: "text",
              text: getErrorMessage(error)
            }
          ]
        };
      }
    }
  );

  return server;
}

app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "eBay Browse MCP",
    version: "1.1.0"
  });
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
    console.error("MCP request failed:", error);

    if (!res.headersSent) {
      res.status(500).json({
        error: "MCP request failed",
        message: getErrorMessage(error)
      });
    }
  } finally {
    try {
      await transport.close();
    } catch {
      // The response may already have closed the transport.
    }

    try {
      await server.close();
    } catch {
      // Ignore cleanup errors.
    }
  }
});

app.use((error, _req, res, _next) => {
  console.error("Express error:", error);

  if (!res.headersSent) {
    res.status(500).json({
      error: "Internal server error"
    });
  }
});

const port = Number(process.env.PORT) || 3000;

app.listen(port, () => {
  console.log(`eBay Browse MCP running on port ${port}`);
});