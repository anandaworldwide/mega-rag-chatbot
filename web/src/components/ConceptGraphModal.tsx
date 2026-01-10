import React, { useState, useEffect, useCallback } from "react";
import { Document } from "langchain/document";
import { DocMetadata } from "@/types/DocMetadata";
import { GraphNode, ConceptGraphResponse } from "@/types/ConceptGraph";
import { buildInitialGraph } from "@/utils/client/graphUtils";
import { Modal } from "@/components/ui/Modal";
import ForceGraph from "@/components/ForceGraph";
import ConceptListView from "@/components/ConceptListView";
import NodeDetailPanel from "@/components/NodeDetailPanel";
import { logEvent } from "@/utils/client/analytics";

interface ConceptGraphModalProps {
  isOpen: boolean;
  onClose: () => void;
  sourceDocs: Document<DocMetadata>[];
  query: string;
}

export default function ConceptGraphModal({ isOpen, onClose, sourceDocs, query }: ConceptGraphModalProps) {
  const [isMobile, setIsMobile] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<any[]>([]);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [centerNode, setCenterNode] = useState<GraphNode | null>(null); // Node to center the graph on
  const [graphWidth, setGraphWidth] = useState(800);
  const [graphHeight, setGraphHeight] = useState(600);

  // Detect mobile breakpoint
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
      // Update graph dimensions
      if (window.innerWidth >= 768) {
        setGraphWidth(Math.min(1000, window.innerWidth - 200));
        setGraphHeight(Math.min(700, window.innerHeight - 200));
      }
    };

    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  // Function to fetch graph data centered on a specific node
  const fetchGraphData = useCallback(
    async (centerOnNode: GraphNode | null = null, preserveOriginalQuery = true) => {
      setLoading(true);
      setError(null);

      try {
        let queryToUse = query;
        let originalQueryNodeToPreserve: GraphNode | null = null;

        // Create original query node for preservation
        const createOriginalQueryNode = (): GraphNode => ({
          id: "query-node",
          label: query.length > 70 ? query.substring(0, 70) + "..." : query,
          type: "query",
          metadata: {
            title: query,
            library: "",
            contentType: "text",
            snippet: query,
          },
        });

        // Create a synthetic document from the node's metadata
        const createSyntheticDoc = (node: GraphNode) => ({
          metadata: {
            title: node.metadata.title,
            author: node.metadata.author,
            library: node.metadata.library,
            type: node.metadata.contentType,
            source: node.metadata.sourceUrl,
            file_hash: node.metadata.sourceId,
          },
          pageContent: node.metadata.snippet,
        });

        // Determine source docs to use
        let sourceDocsForApi: Array<{ metadata: any; pageContent: string }>;

        if (centerOnNode && centerOnNode.id !== "query-node") {
          // Recentering: use the clicked node as the source
          console.log(`[ConceptGraphModal] Recentering on node: ${centerOnNode.metadata.title}`);

          // First try to find the original doc
          const originalDoc = sourceDocs.find((doc) => {
            const docId = doc.metadata.file_hash || doc.metadata.filename || doc.metadata.title;
            return docId === centerOnNode.metadata.sourceId || doc.metadata.title === centerOnNode.metadata.title;
          });

          if (originalDoc) {
            sourceDocsForApi = [
              {
                metadata: originalDoc.metadata,
                pageContent: originalDoc.pageContent,
              },
            ];
          } else {
            // Use synthetic doc from node metadata
            sourceDocsForApi = [createSyntheticDoc(centerOnNode)];
          }

          queryToUse = centerOnNode.metadata.title || query;

          // Preserve original query node
          if (preserveOriginalQuery) {
            originalQueryNodeToPreserve = createOriginalQueryNode();
          }
        } else {
          // Initial load: use all source docs
          sourceDocsForApi = sourceDocs.map((doc) => ({
            metadata: doc.metadata,
            pageContent: doc.pageContent,
          }));
        }

        // Fetch expanded graph from API
        const response = await fetch("/api/concept-graph", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            sourceDocs: sourceDocsForApi,
            query: queryToUse,
            depth: 2,
            maxNodes: 35,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: "Failed to fetch concept graph" }));
          const errorMessage = errorData.error || `HTTP ${response.status}: Failed to fetch concept graph`;
          console.error("[ConceptGraphModal] API error:", errorMessage);
          throw new Error(errorMessage);
        }

        const expandedData: ConceptGraphResponse = await response.json();

        console.log(
          `[ConceptGraphModal] Received graph data: ${expandedData.nodes.length} nodes, ${expandedData.edges.length} edges`
        );

        let finalNodes = [...expandedData.nodes];
        let finalEdges = [...expandedData.edges];

        if (centerOnNode && centerOnNode.id !== "query-node") {
          // RECENTERING: Use API response as base, fix up center node, add link to original query

          // The API's "query-node" IS our center - update its label to the EXACT phrase we had
          const centerNode = finalNodes.find((n) => n.id === "query-node");
          if (centerNode) {
            // CRITICAL: Use the exact label from the clicked node (the phrase the user saw)
            centerNode.label = centerOnNode.label;
            centerNode.type = "source"; // It's a source, not a user query
            // Copy the full metadata from the clicked node
            centerNode.metadata = { ...centerOnNode.metadata };
          }

          // Remove any duplicate source node that represents the same content as the center
          // (API creates both query-node AND source-0 from the same content)
          const centerTitle = centerOnNode.metadata.title;
          const duplicateSourceIndex = finalNodes.findIndex(
            (n) => n.id !== "query-node" && n.type === "source" && n.metadata.title === centerTitle
          );
          if (duplicateSourceIndex !== -1) {
            const duplicateNode = finalNodes[duplicateSourceIndex];
            console.log(
              `[ConceptGraphModal] Removing duplicate source node: ${duplicateNode.id} (${duplicateNode.metadata.title})`
            );

            // Rewire any edges from the duplicate to point to query-node instead
            finalEdges = finalEdges.map((edge) => {
              const sourceId = typeof edge.source === "string" ? edge.source : edge.source.id;
              const targetId = typeof edge.target === "string" ? edge.target : edge.target.id;

              if (sourceId === duplicateNode.id) {
                return { ...edge, source: "query-node" };
              }
              if (targetId === duplicateNode.id) {
                return { ...edge, target: "query-node" };
              }
              return edge;
            });

            // Remove edges that now point to themselves (query-node -> query-node)
            finalEdges = finalEdges.filter((edge) => {
              const sourceId = typeof edge.source === "string" ? edge.source : edge.source.id;
              const targetId = typeof edge.target === "string" ? edge.target : edge.target.id;
              return sourceId !== targetId;
            });

            // Remove the duplicate node
            finalNodes.splice(duplicateSourceIndex, 1);
          }

          // Add original query node as a leaf, connected to the center
          // This preserves the navigation trail back to the original question
          // IMPORTANT: Give it a new ID to avoid conflict with the API's "query-node"
          if (originalQueryNodeToPreserve) {
            const preservedOriginalQuery = {
              ...originalQueryNodeToPreserve,
              id: "original-query-node", // Unique ID to distinguish from new center
            };
            finalNodes.push(preservedOriginalQuery);
            finalEdges.push({
              source: "query-node", // The new center node from API
              target: "original-query-node", // The preserved original query
              weight: 0.5, // Weaker connection to show it's "context" not "related content"
            });
          }
        } else {
          // INITIAL LOAD: Use API response directly (don't merge with client-side graph
          // as that creates duplicate nodes due to different ID generation)
        }

        console.log(`[ConceptGraphModal] Final graph: ${finalNodes.length} nodes, ${finalEdges.length} edges`);

        setNodes(finalNodes);
        setEdges(finalEdges);

        // Set center node to the query-node from the API response (which represents the clicked content)
        const newCenterNode = finalNodes.find((n) => n.id === "query-node");
        setCenterNode(newCenterNode || null);

        logEvent("concept_graph_loaded", "ConceptGraph", `nodes:${finalNodes.length},edges:${finalEdges.length}`);
      } catch (err: any) {
        console.error("[ConceptGraphModal] Error loading concept graph:", err);
        setError(err.message || "Failed to load concept graph");

        // Fallback to initial graph only
        const initialGraph = buildInitialGraph(sourceDocs, query);
        console.log(
          `[ConceptGraphModal] Using fallback graph: ${initialGraph.nodes.length} nodes, ${initialGraph.edges.length} edges`
        );
        setNodes(initialGraph.nodes);
        setEdges(initialGraph.edges);
      } finally {
        setLoading(false);
      }
    },
    [sourceDocs, query]
  );

  // Build initial graph and fetch expanded data
  useEffect(() => {
    if (!isOpen || sourceDocs.length === 0) return;
    // Reset center node when modal opens
    setCenterNode(null);
    fetchGraphData(null, false);
  }, [isOpen, sourceDocs, query, fetchGraphData]);

  const handleNodeClick = useCallback((node: GraphNode | null) => {
    setSelectedNode(node);
    if (node) {
      logEvent("concept_graph_node_click", "ConceptGraph", node.metadata.title);
    }
  }, []);

  const handleNodeDoubleClick = useCallback(
    async (node: GraphNode) => {
      console.log(`[ConceptGraphModal] Recentering graph on node: ${node.metadata.title}`);
      logEvent("concept_graph_recenter", "ConceptGraph", node.metadata.title);
      // Clear selection so panel doesn't show during recenter
      setSelectedNode(null);
      await fetchGraphData(node, true);
      // Don't select the node after recenter - let user click if they want details
    },
    [fetchGraphData]
  );

  const handleClose = useCallback(() => {
    setSelectedNode(null);
    setCenterNode(null);
    onClose();
    logEvent("concept_graph_closed", "ConceptGraph", "");
  }, [onClose]);

  if (!isOpen) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Concept Graph"
      className={isMobile ? "max-w-full mx-0 rounded-none h-full max-h-full" : "max-w-5xl w-full"}
    >
      <div className="relative">
        {loading && (
          <div className="absolute inset-0 bg-white/80 flex items-center justify-center z-10 rounded-lg">
            <div className="flex flex-col items-center">
              <span className="material-icons text-blue-600 animate-spin text-5xl mb-2">refresh</span>
              <p className="text-gray-600">Loading concept graph...</p>
            </div>
          </div>
        )}

        {error && !loading && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-4">
            <p className="text-sm text-yellow-800">
              <span className="material-icons text-lg align-middle mr-2">warning</span>
              {error}
            </p>
          </div>
        )}

        {!loading && nodes.length > 0 && (
          <div className="relative">
            {isMobile ? (
              <div className="pb-4">
                <ConceptListView
                  nodes={nodes}
                  edges={edges}
                  onNodeClick={handleNodeClick}
                  selectedNode={selectedNode?.id || null}
                />
              </div>
            ) : (
              <div className="relative" style={{ height: `${graphHeight}px` }}>
                <ForceGraph
                  nodes={nodes}
                  edges={edges}
                  onNodeClick={handleNodeClick}
                  onNodeDoubleClick={handleNodeDoubleClick}
                  selectedNode={selectedNode?.id || null}
                  centerNodeId={centerNode ? "query-node" : null}
                  width={graphWidth}
                  height={graphHeight}
                />
              </div>
            )}

            {/* Node detail panel */}
            {selectedNode && (
              <NodeDetailPanel node={selectedNode} onClose={() => setSelectedNode(null)} isMobile={isMobile} />
            )}
          </div>
        )}

        {!loading && nodes.length === 0 && !error && (
          <div className="text-center py-12">
            <span className="material-icons text-6xl text-gray-400 mb-4">hub</span>
            <p className="text-lg text-gray-700 mb-2">No concepts found</p>
            <p className="text-sm text-gray-500">Unable to build concept graph from sources.</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
