/**
 * ClusterMapGraph Component
 *
 * Renders a D3 scatter plot visualization using precomputed UMAP coordinates.
 * Shows nodes (sources) colored by cluster ID with zoom/pan capabilities.
 */

import React, { useEffect, useRef, useState } from "react";
import * as d3 from "d3";
import { ClusterMapData, ClusterNode } from "@/types/cluster";

interface ClusterMapGraphProps {
  data: ClusterMapData;
  width?: number;
  height?: number;
  onNodeClick?: (node: ClusterNode) => void;
}

const ClusterMapGraph: React.FC<ClusterMapGraphProps> = ({ data, width = 800, height = 600, onNodeClick }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);

  useEffect(() => {
    if (!svgRef.current || !data.nodes.length) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove(); // Clear previous render

    // Set up dimensions
    const margin = { top: 20, right: 20, bottom: 20, left: 20 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;

    // Create main group
    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    // ============================================================
    // CLUSTER COMPRESSION: Bring clusters closer together visually
    // while preserving internal cluster structure
    // ============================================================

    // Step 1: Group nodes by cluster and calculate cluster centroids
    const clusterMap = new Map<number, { nodes: ClusterNode[]; centroidX: number; centroidY: number }>();

    for (const node of data.nodes) {
      if (!clusterMap.has(node.clusterId)) {
        clusterMap.set(node.clusterId, { nodes: [], centroidX: 0, centroidY: 0 });
      }
      clusterMap.get(node.clusterId)!.nodes.push(node);
    }

    // Calculate centroid for each cluster
    for (const [_clusterId, cluster] of clusterMap.entries()) {
      const sumX = cluster.nodes.reduce((sum, n) => sum + n.umap_x, 0);
      const sumY = cluster.nodes.reduce((sum, n) => sum + n.umap_y, 0);
      cluster.centroidX = sumX / cluster.nodes.length;
      cluster.centroidY = sumY / cluster.nodes.length;
    }

    // Step 2: Calculate global centroid (center of all cluster centroids)
    const clusterCentroids = Array.from(clusterMap.values());
    const globalCentroidX = clusterCentroids.reduce((sum, c) => sum + c.centroidX, 0) / clusterCentroids.length;
    const globalCentroidY = clusterCentroids.reduce((sum, c) => sum + c.centroidY, 0) / clusterCentroids.length;

    // Step 3: Compress cluster positions toward global centroid
    // Each cluster's centroid is moved closer to the global center
    // Nodes within each cluster maintain their relative positions
    const COMPRESSION_FACTOR = 0.02; // Lower = more compression (clusters at 2% of original distance)

    const compressedNodes: { node: ClusterNode; compressedX: number; compressedY: number }[] = [];

    for (const [_clusterId, cluster] of clusterMap.entries()) {
      // Calculate how much to move this cluster's centroid toward global center
      const clusterOffsetX = cluster.centroidX - globalCentroidX;
      const clusterOffsetY = cluster.centroidY - globalCentroidY;

      // Compressed centroid position (move closer to global center)
      const compressedCentroidX = globalCentroidX + clusterOffsetX * COMPRESSION_FACTOR;
      const compressedCentroidY = globalCentroidY + clusterOffsetY * COMPRESSION_FACTOR;

      // Apply same translation to all nodes in this cluster
      // Also compress internal cluster structure to keep nodes tighter
      const INTRA_CLUSTER_SCALE = 0.3; // Scale down internal distances to 30%

      for (const node of cluster.nodes) {
        // Node's position relative to its cluster centroid (scaled down)
        const nodeOffsetX = (node.umap_x - cluster.centroidX) * INTRA_CLUSTER_SCALE;
        const nodeOffsetY = (node.umap_y - cluster.centroidY) * INTRA_CLUSTER_SCALE;

        // New position: compressed centroid + scaled internal offset
        compressedNodes.push({
          node,
          compressedX: compressedCentroidX + nodeOffsetX,
          compressedY: compressedCentroidY + nodeOffsetY,
        });
      }
    }

    // Step 4: Calculate bounds of compressed coordinates
    const compressedXExtent = d3.extent(compressedNodes, (d) => d.compressedX) as [number, number];
    const compressedYExtent = d3.extent(compressedNodes, (d) => d.compressedY) as [number, number];

    if (
      compressedXExtent[0] === undefined ||
      compressedXExtent[1] === undefined ||
      compressedYExtent[0] === undefined ||
      compressedYExtent[1] === undefined
    ) {
      console.error("Invalid compressed coordinate bounds");
      return;
    }

    let xRange = compressedXExtent[1] - compressedXExtent[0];
    let yRange = compressedYExtent[1] - compressedYExtent[0];

    // Handle edge case where all nodes have same coordinates
    if (xRange === 0) xRange = 1;
    if (yRange === 0) yRange = 1;

    // Make the visualization square by using the same scale for both axes
    const maxRange = Math.max(xRange, yRange);
    const xCenter = (compressedXExtent[0] + compressedXExtent[1]) / 2;
    const yCenter = (compressedYExtent[0] + compressedYExtent[1]) / 2;

    // Add padding (15% on each side for breathing room)
    const paddedRange = maxRange * 1.3;

    // Create scales centered on compressed data
    const xScale = d3
      .scaleLinear()
      .domain([xCenter - paddedRange / 2, xCenter + paddedRange / 2])
      .range([0, innerWidth]);
    const yScale = d3
      .scaleLinear()
      .domain([yCenter - paddedRange / 2, yCenter + paddedRange / 2])
      .range([innerHeight, 0]); // Invert Y axis (SVG coordinates)

    // Generate distinct colors for each cluster
    const clusterIds = [...new Set(data.nodes.map((n) => n.clusterId))].filter((id) => id >= 0);
    const clusterColorScale = d3.scaleOrdinal<number, string>().domain(clusterIds).range(d3.schemeTableau10);

    // Color nodes by cluster ID
    const getNodeColor = (node: ClusterNode): string => {
      if (node.clusterId < 0) {
        // Noise nodes: gray
        return "rgba(150, 150, 150, 0.6)";
      }
      // Cluster nodes: distinct colors from Tableau palette
      const baseColor = clusterColorScale(node.clusterId) || "#3b82f6";
      const rgb = d3.rgb(baseColor);
      return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.8)`;
    };

    // Node size - slightly larger for center node
    const getNodeRadius = (node: ClusterNode): number => {
      if (node.id === data.centerNodeId) return 10;
      return 6;
    };

    // Transform nodes to screen coordinates using compressed positions
    const nodePositionMap = new Map(compressedNodes.map((cn) => [cn.node.id, cn]));
    const nodes = data.nodes.map((node) => {
      const compressed = nodePositionMap.get(node.id);
      return {
        ...node,
        x: xScale(compressed?.compressedX ?? node.umap_x),
        y: yScale(compressed?.compressedY ?? node.umap_y),
      };
    });

    // Create nodes (circles)
    g.append("g")
      .attr("class", "nodes")
      .selectAll("circle")
      .data(nodes)
      .enter()
      .append("circle")
      .attr("r", (d) => getNodeRadius(d))
      .attr("cx", (d) => d.x!)
      .attr("cy", (d) => d.y!)
      .attr("fill", (d) => getNodeColor(d))
      .attr("stroke", (d) => {
        // Center node gets gold ring, others get white border
        if (d.id === data.centerNodeId) return "#fbbf24";
        return "rgba(255, 255, 255, 0.8)";
      })
      .attr("stroke-width", (d) => (d.id === data.centerNodeId ? 3 : 1.5))
      .style("cursor", "pointer")
      .style("filter", (d) => {
        // Add glow for center node
        if (d.id === data.centerNodeId) {
          return "drop-shadow(0 0 6px rgba(251, 191, 36, 0.8))";
        }
        return "none";
      })
      .on("mouseover", function (event, d) {
        d3.select(this).attr("r", getNodeRadius(d) * 1.5);
        setTooltip({
          x: event.pageX,
          y: event.pageY,
          text: `${d.title}\n${d.library}\nCluster: ${d.clusterId >= 0 ? d.clusterId + 1 : "Noise"}`,
        });
      })
      .on("mouseout", function (event, d) {
        d3.select(this).attr("r", getNodeRadius(d));
        setTooltip(null);
      })
      .on("click", function (event, d) {
        event.stopPropagation();
        setSelectedNode(d.id);
        if (onNodeClick) {
          onNodeClick(d);
        }
      });

    // Create label group
    const labelGroup = g.append("g").attr("class", "labels");

    // Function to update labels
    const updateLabels = () => {
      const labelNodes = nodes.filter((n) => n.id === data.centerNodeId || n.id === selectedNode);
      labelGroup
        .selectAll("text")
        .data(labelNodes, (d: any) => d.id)
        .join(
          (enter) =>
            enter
              .append("text")
              .attr("font-size", "12px")
              .attr("fill", "#333")
              .attr("text-anchor", "middle")
              .style("pointer-events", "none")
              .style("font-weight", (d) => (d.id === data.centerNodeId ? "bold" : "normal"))
              .text((d) => {
                const maxLength = 30;
                return d.title.length > maxLength ? d.title.substring(0, maxLength) + "..." : d.title;
              })
              .attr("x", (d) => d.x!)
              .attr("y", (d) => d.y! - getNodeRadius(d) - 15),
          (update) =>
            update
              .attr("x", (d) => d.x!)
              .attr("y", (d) => d.y! - getNodeRadius(d) - 15)
              .style("font-weight", (d) => (d.id === data.centerNodeId ? "bold" : "normal")),
          (exit) => exit.remove()
        );
    };

    // Initial label render
    updateLabels();

    // Set up zoom behavior
    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.5, 8])
      .on("zoom", (event) => {
        // Preserve margin offset when zooming
        const transform = event.transform;
        g.attr(
          "transform",
          `translate(${transform.x + margin.left},${transform.y + margin.top}) scale(${transform.k})`
        );
      });

    zoomRef.current = zoom;
    svg.call(zoom);

    // Auto-fit: calculate initial zoom to fill the viewport better
    // Find the bounding box of all nodes in screen coordinates
    if (nodes.length > 1) {
      const screenXs = nodes.map((n) => n.x!);
      const screenYs = nodes.map((n) => n.y!);
      const screenXMin = Math.min(...screenXs);
      const screenXMax = Math.max(...screenXs);
      const screenYMin = Math.min(...screenYs);
      const screenYMax = Math.max(...screenYs);

      const contentWidth = screenXMax - screenXMin;
      const contentHeight = screenYMax - screenYMin;

      // Only auto-zoom if content is smaller than 60% of viewport
      if (contentWidth > 0 && contentHeight > 0) {
        const scaleX = (innerWidth * 0.9) / contentWidth;
        const scaleY = (innerHeight * 0.9) / contentHeight;
        const scale = Math.min(scaleX, scaleY, 2.5); // Cap at 2.5x zoom

        if (scale > 1.2) {
          // Center the content
          const contentCenterX = (screenXMin + screenXMax) / 2;
          const contentCenterY = (screenYMin + screenYMax) / 2;
          const viewportCenterX = innerWidth / 2;
          const viewportCenterY = innerHeight / 2;

          const translateX = viewportCenterX - contentCenterX * scale;
          const translateY = viewportCenterY - contentCenterY * scale;

          svg.call(zoom.transform, d3.zoomIdentity.translate(translateX, translateY).scale(scale));
        }
      }
    }

    // Store update function for external access
    (window as any).__updateClusterLabels = updateLabels;

    // Cleanup
    return () => {
      svg.on(".zoom", null);
      delete (window as any).__updateClusterLabels;
    };
  }, [data, width, height, selectedNode, onNodeClick]);

  // Update labels when selection changes
  useEffect(() => {
    if ((window as any).__updateClusterLabels) {
      (window as any).__updateClusterLabels();
    }
  }, [selectedNode]);

  return (
    <div className="relative">
      <svg ref={svgRef} width={width} height={height} className="border border-gray-200 rounded-lg">
        {/* SVG content is rendered by D3 */}
      </svg>
      {tooltip && (
        <div
          className="absolute bg-gray-900 text-white text-xs rounded px-2 py-1 pointer-events-none z-10 whitespace-pre-line"
          style={{
            left: `${tooltip.x + 10}px`,
            top: `${tooltip.y - 10}px`,
            transform: "translateY(-100%)",
          }}
        >
          {tooltip.text}
        </div>
      )}
    </div>
  );
};

export default ClusterMapGraph;
