// This file handles API requests for comparing responses from different AI models.
// It receives a query and model configurations, then returns responses from both models.

import { NextApiRequest, NextApiResponse } from "next";
import { OpenAIEmbeddings } from "@langchain/openai";
import { PineconeStore } from "@langchain/pinecone";
import { getPineconeClient } from "@/utils/server/pinecone-client";
import { makeChain } from "@/utils/server/makechain";
import { StreamingResponseData } from "@/types/StreamingResponseData";
import { Document } from "@langchain/core/documents";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { loadSiteConfigSync } from "@/utils/server/loadSiteConfig";
import { withApiMiddleware } from "@/utils/server/apiMiddleware";
import { withJwtAuth } from "@/utils/server/jwtUtils";
import { genericRateLimiter } from "@/utils/server/genericRateLimiter";

// Define a type for our filter
type PineconeFilter = {
  $and: Array<{
    [key: string]: {
      $in: string[];
    };
  }>;
};

async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Apply rate limiting
  const isAllowed = await genericRateLimiter(req, res, {
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 50, // 50 requests per 5 minutes
    name: "model-comparison-api",
  });

  if (!isAllowed) {
    return; // Response is already sent by the rate limiter
  }

  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  try {
    const { query, modelA, modelB, temperatureA, temperatureB, mediaTypes, collection } = req.body;

    const pinecone = await getPineconeClient();
    const pineconeIndex = pinecone.Index(process.env.PINECONE_INDEX_NAME || "");

    const vectorStore = await PineconeStore.fromExistingIndex(
      new OpenAIEmbeddings({
        model:
          process.env.OPENAI_EMBEDDINGS_MODEL ||
          (() => {
            console.warn("OPENAI_EMBEDDINGS_MODEL not set, using default text-embedding-ada-002");
            return "text-embedding-ada-002";
          })(),
      }),
      { pineconeIndex }
    );

    // Load site configuration
    const siteConfig = loadSiteConfigSync();
    if (!siteConfig) {
      return res.status(500).json({ error: "Failed to load site configuration" });
    }

    // Create a filter based on mediaTypes and collection
    const filter: PineconeFilter = {
      $and: [
        {
          type: {
            $in: Object.keys(mediaTypes).filter((key) => mediaTypes[key]),
          },
        },
      ],
    };

    // Add author filter for 'master_swami' collection if configured
    if (collection === "master_swami" && siteConfig.collectionConfig?.master_swami) {
      filter.$and.push({
        author: { $in: ["Paramhansa Yogananda", "Swami Kriyananda"] },
      });
    }

    // Add library filter based on site configuration
    if (siteConfig.includedLibraries && siteConfig.includedLibraries.length > 0) {
      const libraryNames = siteConfig.includedLibraries.map((lib) => (typeof lib === "string" ? lib : lib.name));
      filter.$and.push({ library: { $in: libraryNames } });
    }

    async function setupRetrieverAndDocumentPromise() {
      let resolveWithDocuments: (value: Document[]) => void;
      const documentPromise = new Promise<Document[]>((resolve) => {
        resolveWithDocuments = resolve;
      });

      const retriever = vectorStore.asRetriever({
        filter,
        k: 4, // Adjust this value as needed
        callbacks: [
          {
            handleRetrieverEnd(docs: Document[]) {
              resolveWithDocuments(docs);
            },
          } as Partial<BaseCallbackHandler>,
        ],
      });

      return { retriever, documentPromise };
    }

    const setupA = await setupRetrieverAndDocumentPromise();
    const setupB = await setupRetrieverAndDocumentPromise();

    const chainA = await makeChain(
      setupA.retriever,
      {
        model: modelA,
        temperature: temperatureA,
        label: "A",
      },
      4,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      [],
      undefined,
      siteConfig
    );
    const chainB = await makeChain(
      setupB.retriever,
      {
        model: modelB,
        temperature: temperatureB,
        label: "B",
      },
      4,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      [],
      undefined,
      siteConfig
    );

    const [responseA, responseB, docsA, docsB] = await Promise.all([
      chainA.invoke({ question: query, chat_history: "" }),
      chainB.invoke({ question: query, chat_history: "" }),
      setupA.documentPromise,
      setupB.documentPromise,
    ]);
    const responseDataA: StreamingResponseData = {
      token: responseA.answer,
      sourceDocs: docsA,
      done: true,
    };
    const responseDataB: StreamingResponseData = {
      token: responseB.answer,
      sourceDocs: docsB,
      done: true,
    };

    res.status(200).json({
      responseA: responseDataA,
      responseB: responseDataB,
    });
  } catch (error) {
    console.error("Error in model comparison:", error);
    res.status(500).json({ message: "An error occurred during model comparison" });
  }
}

export default withApiMiddleware(withJwtAuth(handler));
