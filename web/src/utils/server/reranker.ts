import { Document } from '@langchain/core/documents';
import { PineconeStore } from '@langchain/pinecone';
import path from 'path';
import fs from 'fs';

// Define scoring interface for reranker results
interface ScoredDocument extends Document {
  score: number;
}

export class DocumentReranker {
  private model: any; // ONNX model for reranking
  private tokenizer: any; // Tokenizer for the model
  private isInitialized: boolean = false;
  // Construct absolute path to ensure correct loading
  private modelPath: string = path.resolve(
    process.cwd(),
    'reranking/onnx_model',
  );

  constructor() {
    // Model will be loaded on demand to reduce cold start impact
  }

  async initialize() {
    if (this.isInitialized) return;

    try {
      console.log('Initializing ONNX reranker model...');
      const startTime = Date.now();

      // Use dynamic import() for ES Modules
      let transformers;
      try {
        transformers = await import('@xenova/transformers');
      } catch (importError) {
        console.error('Error importing ML packages:', importError);
        throw new Error(
          'Required ML packages not available in this environment',
        );
      }

      // First, check if our model file exists, the one the library will actually look for.
      const modelDir = this.modelPath; // This is .../web/reranking/onnx_model
      // The library, when loading 'onnx_model' from localModelPath '.../web/reranking',
      // will look for '.../web/reranking/onnx_model/onnx/model.onnx'
      const specificModelFilePath = path.join(modelDir, 'onnx', 'model.onnx');
      console.log(
        `Checking if specific model file exists at: ${specificModelFilePath}`,
      );

      if (!fs.existsSync(specificModelFilePath)) {
        throw new Error(`Model file not found at ${specificModelFilePath}`);
      }

      // Load tokenizer from the remote model
      this.tokenizer = await transformers.AutoTokenizer.from_pretrained(
        'cross-encoder/ms-marco-MiniLM-L-4-v2',
      );

      // Configure the transformers.js library to use our local model directory
      const originalPath = transformers.env.localModelPath;
      const originalAllowRemote = transformers.env.allowRemoteModels;

      // Point to the absolute path of the parent directory of the model files
      const localModelParentDir = path.resolve(process.cwd(), 'reranking');
      console.log(
        `Setting absolute local model path to: ${localModelParentDir}`,
      );
      transformers.env.localModelPath = localModelParentDir;
      transformers.env.allowRemoteModels = false;

      // Now load the model using the directory name relative to localModelPath
      try {
        console.log(`Loading model from subdirectory: onnx_model`);

        // Check config location relative to the absolute path
        const expectedConfig = path.join(
          localModelParentDir,
          'onnx_model',
          'config.json',
        );
        console.log(`Checking expected config location: ${expectedConfig}`);
        if (fs.existsSync(expectedConfig)) {
          console.log('Expected config file found!');
        } else {
          console.error(
            `Expected config file NOT found at ${expectedConfig}! This is the primary issue.`,
          );
          // Optionally, list directory contents for debugging
          try {
            const parentContents = fs.readdirSync(localModelParentDir);
            console.log(`Contents of ${localModelParentDir}:`, parentContents);
            const modelDirContents = fs.readdirSync(
              path.join(localModelParentDir, 'onnx_model'),
            );
            console.log(
              `Contents of ${path.join(localModelParentDir, 'onnx_model')}:`,
              modelDirContents,
            );
          } catch (readdirError) {
            console.error('Error reading directory contents:', readdirError);
          }
        }

        // Attempt to load the model using the subdirectory name
        this.model =
          await transformers.AutoModelForSequenceClassification.from_pretrained(
            'onnx_model',
            { local_files_only: true },
          );
        console.log(
          'Model loaded successfully using standard approach (with absolute localModelPath).',
        );
      } catch (modelErr) {
        console.error(
          `Standard loading failed even with absolute path: ${(modelErr as Error).message}`,
        );
        // Simplified: Throw error directly if standard loading fails, remove complex fallbacks for now
        throw new Error(
          `Failed to load model from ${localModelParentDir}/onnx_model: ${modelErr}`,
        );
      } finally {
        // Restore original settings
        transformers.env.localModelPath = originalPath;
        transformers.env.allowRemoteModels = originalAllowRemote;
      }

      this.isInitialized = true;
      console.log(
        `Reranker initialization completed in ${Date.now() - startTime}ms`,
      );
    } catch (error) {
      console.error('Failed to initialize reranker:', error);
      throw new Error('Reranker initialization failed');
    }
  }

  async rerankDocuments(
    query: string,
    documents: Document[],
  ): Promise<ScoredDocument[]> {
    // Initialize model if not already done
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      const rerankStartTime = Date.now();
      const scoredDocs: ScoredDocument[] = [];

      // Create query-document pairs
      const pairs = documents.map((doc) => [query, doc.pageContent]);

      // Tokenize
      const inputs = await this.tokenizer(pairs, {
        padding: true,
        truncation: true,
        max_length: 512,
        return_tensors: 'np', // ONNX uses numpy arrays
      });

      // Get scores from model
      const outputs = await this.model(inputs);

      // Extract and process scores
      let scores = outputs.logits;
      if (scores.length > 0 && scores.ndim > 1) {
        scores = scores.squeeze();
      }

      // Create scored documents
      for (let i = 0; i < documents.length; i++) {
        scoredDocs.push({
          ...documents[i],
          score: parseFloat(scores[i]),
        });
      }

      // Sort by score in descending order
      const rankedDocs = scoredDocs.sort((a, b) => b.score - a.score);

      console.log(
        `Reranking ${documents.length} documents took ${Date.now() - rerankStartTime}ms`,
      );
      return rankedDocs;
    } catch (error) {
      console.error('Error during reranking:', error);
      // Fallback: return original documents without reranking
      return documents.map((doc) => ({ ...doc, score: 0 }));
    }
  }
}

// Main function to use in the RAG pipeline
export async function applyReranking(
  query: string,
  retriever: ReturnType<PineconeStore['asRetriever']>,
  filter?: any,
  expandedSourceCount: number = 15,
  finalSourceCount: number = 4,
  retrievedDocs?: Document[],
): Promise<Document[]> {
  try {
    let documentsToRerank: Document[];

    if (retrievedDocs) {
      // Use provided documents if available
      console.log(
        `Reranking ${retrievedDocs.length} pre-retrieved documents...`,
      );
      documentsToRerank = retrievedDocs;
    } else {
      // Fallback: Retrieve documents if not provided (shouldn't happen with current route.ts logic)
      console.warn(
        'applyReranking called without pre-retrieved documents. Retrieving now...',
      );
      const retrievalStartTime = Date.now();
      const originalK = retriever.k;
      retriever.k = expandedSourceCount;
      documentsToRerank = await retriever.invoke(query);
      retriever.k = originalK;
      console.log(
        `Fallback retrieval took ${Date.now() - retrievalStartTime}ms`,
      );
    }

    console.log(`Getting ${expandedSourceCount} documents for reranking`);

    if (documentsToRerank.length <= finalSourceCount) {
      console.log(
        'Too few documents to rerank, returning all retrieved documents',
      );
      return documentsToRerank;
    }

    // Create reranker and rerank documents
    const reranker = new DocumentReranker();
    const rankedDocs = await reranker.rerankDocuments(query, documentsToRerank);

    // Take top K documents after reranking
    return rankedDocs.slice(0, finalSourceCount);
  } catch (error) {
    console.error('Error in reranking process:', error);
    // Fallback to original retrieval with fewer documents in case of error
    // Use the originally requested finalSourceCount for fallback
    const originalK = retriever.k;
    retriever.k = finalSourceCount;
    const fallbackDocs = await retriever.invoke(query);
    retriever.k = originalK;
    return fallbackDocs;
  }
}
