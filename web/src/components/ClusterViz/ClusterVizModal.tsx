/**
 * ClusterVizModal Component
 *
 * Modal wrapper for the cluster visualization feature.
 * Fetches related sources from the API and displays them in a force-directed graph.
 */

import React, { useState, useEffect } from "react";
import { Document } from "langchain/document";
import { DocMetadata } from "@/types/DocMetadata";
import { ClusterMapData, ClusterNode } from "@/types/cluster";
import ClusterMapGraph from "./ForceGraph"; // Note: File is named ForceGraph.tsx but exports ClusterMapGraph
import { logEvent } from "@/utils/client/analytics";
import { fetchWithAuth } from "@/utils/client/tokenManager";
import * as d3 from "d3";

interface ClusterVizModalProps {
  isOpen: boolean;
  onClose: () => void;
  sourceDoc: Document<DocMetadata> | null;
}

const ClusterVizModal: React.FC<ClusterVizModalProps> = ({ isOpen, onClose, sourceDoc }) => {
  const [mapData, setMapData] = useState<ClusterMapData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<ClusterNode | null>(null);

  // Fetch cluster map data when modal opens with a source document
  useEffect(() => {
    if (!isOpen || !sourceDoc) {
      setMapData(null);
      setError(null);
      return;
    }

    const metadata = sourceDoc.metadata;

    // Check if source has precomputed visualization metadata
    if (
      !metadata.viz_subset ||
      typeof metadata.umap_x !== "number" ||
      typeof metadata.umap_y !== "number" ||
      typeof metadata.cluster_id !== "number"
    ) {
      setError("This source does not have precomputed cluster visualization data.");
      setLoading(false);
      return;
    }

    const fetchClusterMap = async () => {
      setLoading(true);
      setError(null);
      setMapData(null);

      try {
        logEvent("cluster_map_opened", "Engagement", metadata.title || "unknown");

        const response = await fetchWithAuth("/api/cluster-map", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            umap_x: metadata.umap_x,
            umap_y: metadata.umap_y,
            cluster_id: metadata.cluster_id,
            title: metadata.title || metadata["pdf.info.Title"] || "Unknown source",
            vectorId: undefined, // Could be added if we track Pinecone IDs
          }),
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || "Failed to fetch cluster map");
        }

        const data: ClusterMapData = await response.json();
        setMapData(data);
        logEvent("cluster_map_loaded", "Engagement", `${data.nodes.length} nodes`);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Unknown error occurred";
        setError(errorMessage);
        console.error("Error fetching cluster map:", err);
        logEvent("cluster_map_error", "Error", errorMessage);
      } finally {
        setLoading(false);
      }
    };

    fetchClusterMap();
  }, [isOpen, sourceDoc]);

  // Handle node click
  const handleNodeClick = (node: ClusterNode) => {
    setSelectedNode(node);
    logEvent("cluster_viz_node_clicked", "Engagement", node.title);
  };

  // Calculate responsive dimensions
  const getDimensions = () => {
    if (typeof window === "undefined") {
      return { width: 800, height: 600 };
    }

    // Mobile: fullscreen minus padding
    if (window.innerWidth < 768) {
      return {
        width: window.innerWidth - 40,
        height: window.innerHeight - 200,
      };
    }

    // Desktop: large modal
    return {
      width: Math.min(1000, window.innerWidth - 100),
      height: Math.min(700, window.innerHeight - 150),
    };
  };

  const dimensions = getDimensions();

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black bg-opacity-50 transition-opacity" onClick={onClose} aria-hidden="true" />

      {/* Modal */}
      <div
        className="relative bg-white rounded-xl shadow-xl max-w-7xl w-full mx-4 max-h-[90vh] overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cluster-viz-title"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div>
            <h2 id="cluster-viz-title" className="text-lg font-semibold text-gray-900">
              Cluster Map
            </h2>
            {sourceDoc && (
              <p className="text-sm text-gray-500 mt-1">
                Showing cluster and nearby clusters for: {sourceDoc.metadata.title || "Unknown source"}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            aria-label="Close modal"
          >
            <span className="material-icons text-2xl">close</span>
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <div className="text-center">
                <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mb-4"></div>
                <p className="text-gray-600">Loading cluster map...</p>
              </div>
            </div>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
              <p className="text-red-800 font-medium">Error loading visualization</p>
              <p className="text-red-600 text-sm mt-1">{error}</p>
            </div>
          )}

          {mapData && !loading && (
            <>
              <div className="mb-4 flex items-center justify-between flex-wrap gap-2">
                <div className="text-sm text-gray-600">
                  Showing {mapData.nodes.length} sources from {mapData.clusterCentroids.length} clusters
                </div>
                <div className="flex items-center gap-4 text-xs text-gray-500 flex-wrap">
                  {/* Cluster legend */}
                  {(() => {
                    const clusterIds = [...new Set(mapData.nodes.map((n) => n.clusterId))].filter((id) => id >= 0);
                    const clusterColorScale = d3
                      .scaleOrdinal<number, string>()
                      .domain(clusterIds)
                      .range(d3.schemeTableau10);

                    return (
                      <>
                        {clusterIds.length > 0 && (
                          <>
                            {clusterIds.map((id) => (
                              <div key={id} className="flex items-center gap-1">
                                <div
                                  className="w-3 h-3 rounded-full"
                                  style={{ backgroundColor: clusterColorScale(id) }}
                                />
                                <span>Cluster {id + 1}</span>
                              </div>
                            ))}
                            <div className="flex items-center gap-1">
                              <div className="w-3 h-3 rounded-full bg-gray-400 opacity-50"></div>
                              <span>Noise</span>
                            </div>
                          </>
                        )}
                      </>
                    );
                  })()}
                  <div className="flex items-center gap-1">
                    <div className="w-3 h-3 rounded-full border-2 border-yellow-400 bg-transparent"></div>
                    <span>Center</span>
                  </div>
                </div>
              </div>

              <div className="mb-2 text-xs text-gray-500">
                <p>Click and drag to pan, scroll to zoom. Click nodes to see details.</p>
              </div>

              <div className="flex justify-center">
                <ClusterMapGraph
                  data={mapData}
                  width={dimensions.width}
                  height={dimensions.height}
                  onNodeClick={handleNodeClick}
                />
              </div>

              {selectedNode && (
                <div className="mt-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
                  <h3 className="font-semibold text-gray-900 mb-2">{selectedNode.title}</h3>
                  <div className="text-sm text-gray-600 mb-2">
                    <span className="font-medium">Library:</span> {selectedNode.library}
                    {selectedNode.metadata?.author && (
                      <>
                        {" • "}
                        <span className="font-medium">Author:</span> {selectedNode.metadata.author}
                      </>
                    )}
                    {" • "}
                    <span className="font-medium">Cluster:</span>{" "}
                    {selectedNode.clusterId >= 0 ? `Cluster ${selectedNode.clusterId + 1}` : "Noise"}
                  </div>
                  <p className="text-sm text-gray-700 mt-2">{selectedNode.snippet}</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default ClusterVizModal;
