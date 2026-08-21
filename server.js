import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT) || 3000;
const EBAY_API_BASE =
  process.env.EBAY_API_BASE || "https://api.ebay.com";
const EBAY_SCOPE = "https://api.ebay.com/oauth/api_scope";
const DEFAULT_MARKETPLACE = "EBAY_US";
const REQUEST_TIMEOUT_MS = 20_000;

let tokenCache = {
  accessToken: null,
  expiresAt: 0
};

/*
 * These are MCP field maps.
 * Do not wrap them in z.object() when assigning outputSchema.
 */
const moneyShape = {
  value: z.string().optional(),
  currency: z.string().optional()
};

const availabilityShape = {
  deliveryOptions: z.array(z.string()).optional(),
  availabilityThreshold: z.number().optional(),
  availabilityThresholdType: z.string().optional(),
  estimatedAvailabilityStatus: z.string().optional(),
  estimatedAvailableQuantity: z.number().optional(),
  estimatedSoldQuantity: z.number().optional()
};

const sellerShape = {
  username: z.string().optional(),
  feedbackPercentage: z.string().optional(),
  feedbackScore: z.number().optional(),
  sellerAccountType: z.string().optional()
};

const outputShape = {
  requestedItemId: z.string(),
  marketplaceId: z.string(),

  itemId: z.string().optional(),
  legacyItemId: z.string().optional(),
  title: z.string().optional(),
  shortDescription: z.string().optional(),

  price: z.object(moneyShape).nullable(),
  currentBidPrice: z.object(moneyShape).nullable(),

  buyingOptions: z.array(z.string()),

  availabilityStatus: z.enum([
    "IN_STOCK",
    "LIMITED_STOCK",
    "OUT_OF_STOCK",
    "ENDED",
    "UNKNOWN"
  ]),

  publicQuantityAvailable: z.number().nullable(),
  publicQuantitySold: z.number().nullable(),
  quantityIsEstimated: z.boolean(),

  estimatedAvailabilities: z.array(
    z.object(availabilityShape)
  ),

  itemEndDate: z.string().optional(),
  itemWebUrl: z.string().optional(),

  condition: z.string().optional(),
  conditionId: z.string().optional(),
  categoryPath: z.string().optional(),

  enabledForGuestCheckout: z.boolean().optional(),

  seller: z.object(sellerShape).nullable(),

  /*
   * This preserves every field returned by eBay, including fields
   * not explicitly represented in the normalized output.
   */
  rawEbayResponseJson: z.string()
};

const outputValidator = z.object(outputShape);

function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function optionalString(value) {
  if (value === undefined || value === null) {
    return undefined;
  }

  return String(value);
}

function optionalNumber(value) {
  if (
    typeof value === "number" &&
    Number.isFinite(value)
  ) {
    return value;
  }

  if (
    typeof value === "string" &&
    value.trim() !== ""
  ) {
    const parsed = Number(value);

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function cleanObject(object) {
  return Object.fromEntries(
    Object.entries(object).filter(
      ([, value]) => value !== undefined
    )
  );
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(
        `The request timed out after ${REQUEST_TIMEOUT_MS}ms.`
      );
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function parseResponse(response) {
  const text = await response.text();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `eBay returned invalid JSON with HTTP ${response.status}.`
    );
  }
}

function formatEbayError(data, status) {
  const errors = Array.isArray(data?.errors)
    ? data.errors
    : [];

  if (errors.length > 0) {
    return errors
      .map((error) => {
        const message =
          error.longMessage ||
          error.message ||
          "Unknown eBay error";

        const parameters = Array.isArray(error.parameters)
          ? error.parameters
              .map(
                (parameter) =>
                  `${parameter.name}: ${parameter.value}`
              )
              .join(", ")
          : "";

        return parameters
          ? `${message} (${parameters})`
          : message;
      })
      .join("; ");
  }

  if (status === 400) {
    return "eBay rejected the lookup parameters.";
  }

  if (status === 401) {
    return "eBay rejected the access token.";
  }

  if (status === 403) {
    return "The eBay application does not have permission for this lookup.";
  }

  if (status === 404) {
    return "The eBay listing was not found.";
  }

  if (status === 429) {
    return "The eBay API rate limit was reached.";
  }

  return `eBay lookup failed with HTTP ${status}.`;
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
    `${EBAY_API_BASE}/identity/v1/oauth2/token`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type":
          "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: EBAY_SCOPE
      })
    }
  );

  const data = await parseResponse(response);

  if (!response.ok || !data.access_token) {
    throw new Error(
      formatEbayError(data, response.status)
    );
  }

  const expiresIn =
    optionalNumber(data.expires_in) || 7200;

  tokenCache = {
    accessToken: data.access_token,
    expiresAt: now + expiresIn * 1000
  };

  return tokenCache.accessToken;
}

function buildItemUrl({
  itemId,
  legacyVariationId,
  legacyVariationSku
}) {
  /*
   * Numeric IDs are traditional eBay item numbers.
   * REST item IDs normally contain pipe characters.
   */
  if (/^\d+$/.test(itemId)) {
    const query = new URLSearchParams({
      legacy_item_id: itemId,
      fieldgroups:
        "PRODUCT,ADDITIONAL_SELLER_DETAILS"
    });

    if (legacyVariationId) {
      query.set(
        "legacy_variation_id",
        legacyVariationId
      );
    }

    if (legacyVariationSku) {
      query.set(
        "legacy_variation_sku",
        legacyVariationSku
      );
    }

    return (
      `${EBAY_API_BASE}/buy/browse/v1/item/` +
      `get_item_by_legacy_id?${query.toString()}`
    );
  }

  return (
    `${EBAY_API_BASE}/buy/browse/v1/item/` +
    encodeURIComponent(itemId) +
    "?fieldgroups=PRODUCT,ADDITIONAL_SELLER_DETAILS"
  );
}

function normalizeMoney(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const normalized = cleanObject({
    value: optionalString(value.value),
    currency: optionalString(value.currency)
  });

  return Object.keys(normalized).length > 0
    ? normalized
    : null;
}

function normalizeAvailability(value) {
  return cleanObject({
    deliveryOptions: Array.isArray(
      value?.deliveryOptions
    )
      ? value.deliveryOptions.map(String)
      : undefined,

    availabilityThreshold: optionalNumber(
      value?.availabilityThreshold
    ),

    availabilityThresholdType: optionalString(
      value?.availabilityThresholdType
    ),

    estimatedAvailabilityStatus:
      optionalString(
        value?.estimatedAvailabilityStatus
      ),

    estimatedAvailableQuantity:
      optionalNumber(
        value?.estimatedAvailableQuantity
      ),

    estimatedSoldQuantity: optionalNumber(
      value?.estimatedSoldQuantity
    )
  });
}

function normalizeSeller(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const normalized = cleanObject({
    username: optionalString(value.username),

    feedbackPercentage: optionalString(
      value.feedbackPercentage
    ),

    feedbackScore: optionalNumber(
      value.feedbackScore
    ),

    sellerAccountType: optionalString(
      value.sellerAccountType
    )
  });

  return Object.keys(normalized).length > 0
    ? normalized
    : null;
}

function calculateAvailability(
  data,
  estimatedAvailabilities
) {
  const statuses = estimatedAvailabilities
    .map(
      (availability) =>
        availability.estimatedAvailabilityStatus
    )
    .filter(Boolean);

  const availableQuantities =
    estimatedAvailabilities
      .map(
        (availability) =>
          availability.estimatedAvailableQuantity
      )
      .filter(
        (quantity) =>
          typeof quantity === "number"
      );

  const soldQuantities = estimatedAvailabilities
    .map(
      (availability) =>
        availability.estimatedSoldQuantity
    )
    .filter(
      (quantity) =>
        typeof quantity === "number"
    );

  const totalAvailable =
    availableQuantities.length > 0
      ? availableQuantities.reduce(
          (total, quantity) =>
            total + quantity,
          0
        )
      : null;

  const totalSold =
    soldQuantities.length > 0
      ? soldQuantities.reduce(
          (total, quantity) =>
            total + quantity,
          0
        )
      : null;

  if (
    statuses.some((status) =>
      [
        "OUT_OF_STOCK",
        "TEMPORARILY_OUT_OF_STOCK"
      ].includes(status)
    )
  ) {
    return {
      availabilityStatus: "OUT_OF_STOCK",
      publicQuantityAvailable:
        totalAvailable ?? 0,
      publicQuantitySold: totalSold,
      quantityIsEstimated: true
    };
  }

  if (
    statuses.some((status) =>
      [
        "LIMITED_STOCK",
        "LOW_STOCK"
      ].includes(status)
    )
  ) {
    return {
      availabilityStatus: "LIMITED_STOCK",
      publicQuantityAvailable: totalAvailable,
      publicQuantitySold: totalSold,
      quantityIsEstimated: true
    };
  }

  if (
    statuses.includes("IN_STOCK") ||
    (totalAvailable !== null &&
      totalAvailable > 0)
  ) {
    return {
      availabilityStatus: "IN_STOCK",
      publicQuantityAvailable: totalAvailable,
      publicQuantitySold: totalSold,
      quantityIsEstimated:
        availableQuantities.length > 0
    };
  }

  if (data.itemEndDate) {
    const endTime = Date.parse(data.itemEndDate);

    if (
      Number.isFinite(endTime) &&
      endTime <= Date.now()
    ) {
      return {
        availabilityStatus: "ENDED",
        publicQuantityAvailable: null,
        publicQuantitySold: totalSold,
        quantityIsEstimated: false
      };
    }
  }

  if (
    Array.isArray(data.buyingOptions) &&
    data.buyingOptions.length > 0
  ) {
    return {
      availabilityStatus: "IN_STOCK",
      publicQuantityAvailable: null,
      publicQuantitySold: totalSold,
      quantityIsEstimated: false
    };
  }

  return {
    availabilityStatus: "UNKNOWN",
    publicQuantityAvailable: null,
    publicQuantitySold: totalSold,
    quantityIsEstimated: false
  };
}

async function findItem({
  itemId,
  marketplaceId,
  legacyVariationId,
  legacyVariationSku
}) {
  const token = await getEbayToken();

  const url = buildItemUrl({
    itemId,
    legacyVariationId,
    legacyVariationSku
  });

  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID":
        marketplaceId,
      Accept: "application/json"
    }
  });

  const data = await parseResponse(response);

  if (!response.ok) {
    throw new Error(
      formatEbayError(data, response.status)
    );
  }

  const estimatedAvailabilities =
    Array.isArray(data.estimatedAvailabilities)
      ? data.estimatedAvailabilities.map(
          normalizeAvailability
        )
      : [];

  const availability =
    calculateAvailability(
      data,
      estimatedAvailabilities
    );

  const normalized = cleanObject({
    requestedItemId: itemId,
    marketplaceId,

    itemId: optionalString(data.itemId),
    legacyItemId: optionalString(
      data.legacyItemId
    ),

    title: optionalString(data.title),

    shortDescription: optionalString(
      data.shortDescription
    ),

    price: normalizeMoney(data.price),

    currentBidPrice: normalizeMoney(
      data.currentBidPrice
    ),

    buyingOptions: Array.isArray(
      data.buyingOptions
    )
      ? data.buyingOptions.map(String)
      : [],

    ...availability,

    estimatedAvailabilities,

    itemEndDate: optionalString(
      data.itemEndDate
    ),

    itemWebUrl: optionalString(
      data.itemWebUrl
    ),

    condition: optionalString(
      data.condition
    ),

    conditionId: optionalString(
      data.conditionId
    ),

    categoryPath: optionalString(
      data.categoryPath
    ),

    enabledForGuestCheckout:
      typeof data.enabledForGuestCheckout ===
      "boolean"
        ? data.enabledForGuestCheckout
        : undefined,

    seller: normalizeSeller(data.seller),

    rawEbayResponseJson: JSON.stringify(
      data,
      null,
      2
    )
  });

  return outputValidator.parse(normalized);
}

function createServer() {
  const server = new McpServer({
    name: "eBay Browse Connector",
    version: "2.0.0"
  });

  server.registerTool(
    "lookup_ebay_item",
    {
      title: "Look up an eBay item",

      description:
        "Read a public eBay listing by item number or REST item ID and return normalized availability plus the complete eBay response.",

      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },

      inputSchema: {
        itemId: z
          .string()
          .trim()
          .min(1)
          .describe(
            "The eBay item number or Browse REST item ID"
          ),

        marketplaceId: z
          .string()
          .trim()
          .min(1)
          .default(DEFAULT_MARKETPLACE)
          .describe(
            "The marketplace ID, such as EBAY_US"
          ),

        legacyVariationId: z
          .string()
          .trim()
          .optional()
          .describe(
            "Optional variation ID for a multi-variation listing"
          ),

        legacyVariationSku: z
          .string()
          .trim()
          .optional()
          .describe(
            "Optional seller SKU for a multi-variation listing"
          )
      },

      outputSchema: outputShape
    },

    async ({
      itemId,
      marketplaceId,
      legacyVariationId,
      legacyVariationSku
    }) => {
      try {
        const item = await findItem({
          itemId: itemId.trim(),

          marketplaceId:
            marketplaceId
              .trim()
              .toUpperCase(),

          legacyVariationId:
            legacyVariationId?.trim() ||
            undefined,

          legacyVariationSku:
            legacyVariationSku?.trim() ||
            undefined
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                item,
                null,
                2
              )
            }
          ],

          structuredContent: item
        };
      } catch (error) {
        const message = getErrorMessage(error);

        console.error(
          "lookup_ebay_item failed:",
          message
        );

        return {
          isError: true,

          content: [
            {
              type: "text",
              text: message
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
    version: "2.0.0"
  });
});

app.post("/mcp", async (req, res) => {
  const server = createServer();

  const transport =
    new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });

  try {
    await server.connect(transport);

    await transport.handleRequest(
      req,
      res,
      req.body
    );
  } catch (error) {
    console.error(
      "MCP request failed:",
      error
    );

    if (!res.headersSent) {
      res.status(500).json({
        error: "MCP request failed",
        message: getErrorMessage(error)
      });
    }
  }
});

app.use((error, _req, res, _next) => {
  console.error("Express error:", error);

  if (!res.headersSent) {
    res.status(500).json({
      error: "Internal server error",
      message: getErrorMessage(error)
    });
  }
});

app.listen(PORT, () => {
  console.log(
    `eBay Browse MCP running on port ${PORT}`
  );
});