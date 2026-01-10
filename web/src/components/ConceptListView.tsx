import React, { useState } from "react";
import { GraphNode, GraphEdge } from "@/types/ConceptGraph";
import { getNodeColor } from "@/utils/client/graphUtils";

interface ConceptListViewProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onNodeClick: (node: GraphNode) => void;
  selectedNode: string | null;
}

export default function ConceptListView({ nodes, edges, onNodeClick, selectedNode }: ConceptListViewProps) {
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(["query", "sources"]));

  // Group nodes by type
  const queryNode = nodes.find((n) => n.type === "query");
  const sourceNodes = nodes.filter((n) => n.type === "source");
  const relatedNodes = nodes.filter((n) => n.type === "related");

  // Build map of source -> related nodes
  const sourceToRelated = new Map<string, GraphNode[]>();
  edges.forEach((edge) => {
    const sourceId = typeof edge.source === "string" ? edge.source : edge.source.id;
    const targetId = typeof edge.target === "string" ? edge.target : edge.target.id;

    const sourceNode = nodes.find((n) => n.id === sourceId);
    const targetNode = nodes.find((n) => n.id === targetId);

    if (sourceNode && targetNode && targetNode.type === "related") {
      if (!sourceToRelated.has(sourceId)) {
        sourceToRelated.set(sourceId, []);
      }
      sourceToRelated.get(sourceId)!.push(targetNode);
    }
  });

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  };

  const getContentTypeIcon = (contentType: string) => {
    switch (contentType) {
      case "audio":
        return "mic";
      case "youtube":
        return "videocam";
      default:
        return "description";
    }
  };

  const formatSimilarityScore = (weight: number): string => {
    return `${Math.round(weight * 100)}%`;
  };

  return (
    <div className="space-y-4">
      {/* Query Node */}
      {queryNode && (
        <div className="border-b border-gray-200 pb-4">
          <div
            className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer ${
              selectedNode === queryNode.id ? "bg-purple-50 border-2 border-purple-500" : "bg-gray-50 hover:bg-gray-100"
            }`}
            onClick={() => onNodeClick(queryNode)}
          >
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-semibold"
              style={{ backgroundColor: getNodeColor(queryNode.metadata.contentType, queryNode.type) }}
            >
              Q
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium text-gray-900">{queryNode.metadata.title}</p>
              <p className="text-xs text-gray-500">Query</p>
            </div>
          </div>
        </div>
      )}

      {/* Source Nodes */}
      {sourceNodes.length > 0 && (
        <div>
          <button
            onClick={() => toggleSection("sources")}
            className="w-full flex items-center justify-between p-3 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
          >
            <span className="font-semibold text-gray-900">Sources ({sourceNodes.length})</span>
            <span className="material-icons text-gray-600">
              {expandedSections.has("sources") ? "expand_less" : "expand_more"}
            </span>
          </button>

          {expandedSections.has("sources") && (
            <div className="mt-2 space-y-2">
              {sourceNodes.map((node) => {
                const related = sourceToRelated.get(node.id) || [];
                return (
                  <div key={node.id} className="border border-gray-200 rounded-lg overflow-hidden">
                    <div
                      className={`p-3 cursor-pointer ${
                        selectedNode === node.id ? "bg-blue-50 border-l-4 border-blue-500" : "hover:bg-gray-50"
                      }`}
                      onClick={() => onNodeClick(node)}
                    >
                      <div className="flex items-start gap-3">
                        <span
                          className="material-icons text-lg"
                          style={{ color: getNodeColor(node.metadata.contentType, node.type) }}
                        >
                          {getContentTypeIcon(node.metadata.contentType)}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-gray-900 text-sm">{node.metadata.title}</p>
                          {node.metadata.author && node.metadata.author !== "Unknown" && (
                            <p className="text-xs text-gray-600 italic">by {node.metadata.author}</p>
                          )}
                          {node.metadata.library && (
                            <p className="text-xs text-gray-500 mt-1">{node.metadata.library}</p>
                          )}
                          {related.length > 0 && (
                            <p className="text-xs text-blue-600 mt-1">{related.length} related concepts</p>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Related nodes nested under source */}
                    {related.length > 0 && expandedSections.has(`source-${node.id}`) && (
                      <div className="bg-gray-50 border-t border-gray-200 pl-8 pr-3 py-2 space-y-2">
                        {related.map((relatedNode) => {
                          const edge = edges.find((e) => {
                            const sourceId = typeof e.source === "string" ? e.source : e.source.id;
                            const targetId = typeof e.target === "string" ? e.target : e.target.id;
                            return sourceId === node.id && targetId === relatedNode.id;
                          });
                          const weight = edge?.weight || 0.8;

                          return (
                            <div
                              key={relatedNode.id}
                              className={`p-2 rounded cursor-pointer ${
                                selectedNode === relatedNode.id
                                  ? "bg-green-50 border border-green-300"
                                  : "hover:bg-white"
                              }`}
                              onClick={(e) => {
                                e.stopPropagation();
                                onNodeClick(relatedNode);
                              }}
                            >
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2 flex-1 min-w-0">
                                  <span
                                    className="material-icons text-sm"
                                    style={{ color: getNodeColor(relatedNode.metadata.contentType, relatedNode.type) }}
                                  >
                                    {getContentTypeIcon(relatedNode.metadata.contentType)}
                                  </span>
                                  <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium text-gray-900 truncate">
                                      {relatedNode.metadata.title}
                                    </p>
                                    {relatedNode.metadata.author && relatedNode.metadata.author !== "Unknown" && (
                                      <p className="text-xs text-gray-600 italic">by {relatedNode.metadata.author}</p>
                                    )}
                                  </div>
                                </div>
                                <span className="text-xs text-gray-500 bg-gray-200 px-2 py-1 rounded">
                                  {formatSimilarityScore(weight)}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Expand button for related nodes */}
                    {related.length > 0 && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleSection(`source-${node.id}`);
                        }}
                        className="w-full px-3 py-2 text-xs text-blue-600 hover:bg-gray-50 border-t border-gray-200 flex items-center justify-center gap-1"
                      >
                        <span className="material-icons text-sm">
                          {expandedSections.has(`source-${node.id}`) ? "expand_less" : "expand_more"}
                        </span>
                        {expandedSections.has(`source-${node.id}`) ? "Hide" : "Show"} {related.length} related
                        {related.length === 1 ? " concept" : " concepts"}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Standalone Related Nodes (if any) */}
      {relatedNodes.filter((n) => {
        // Only show if not already shown under a source
        return !Array.from(sourceToRelated.values()).some((related) => related.includes(n));
      }).length > 0 && (
        <div>
          <button
            onClick={() => toggleSection("related")}
            className="w-full flex items-center justify-between p-3 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
          >
            <span className="font-semibold text-gray-900">Related Concepts ({relatedNodes.length})</span>
            <span className="material-icons text-gray-600">
              {expandedSections.has("related") ? "expand_less" : "expand_more"}
            </span>
          </button>

          {expandedSections.has("related") && (
            <div className="mt-2 space-y-2">
              {relatedNodes
                .filter((n) => {
                  return !Array.from(sourceToRelated.values()).some((related) => related.includes(n));
                })
                .map((node) => (
                  <div
                    key={node.id}
                    className={`p-3 border border-gray-200 rounded-lg cursor-pointer ${
                      selectedNode === node.id ? "bg-green-50 border-green-300" : "hover:bg-gray-50"
                    }`}
                    onClick={() => onNodeClick(node)}
                  >
                    <div className="flex items-start gap-3">
                      <span
                        className="material-icons text-lg"
                        style={{ color: getNodeColor(node.metadata.contentType, node.type) }}
                      >
                        {getContentTypeIcon(node.metadata.contentType)}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-gray-900 text-sm">{node.metadata.title}</p>
                        {node.metadata.author && node.metadata.author !== "Unknown" && (
                          <p className="text-xs text-gray-600 italic">by {node.metadata.author}</p>
                        )}
                        {node.metadata.library && <p className="text-xs text-gray-500 mt-1">{node.metadata.library}</p>}
                      </div>
                    </div>
                  </div>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
