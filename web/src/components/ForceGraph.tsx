import React, { useEffect, useRef, useState, useCallback } from "react";
import * as d3 from "d3";
import { GraphNode, GraphEdge } from "@/types/ConceptGraph";
import { getNodeColor } from "@/utils/client/graphUtils";

interface ForceGraphProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onNodeClick: (node: GraphNode | null) => void;
  onNodeDoubleClick?: (node: GraphNode) => void;
  onNodeHover?: (node: GraphNode | null) => void;
  selectedNode: string | null;
  centerNodeId?: string | null; // Node to show with halo (after recentering)
  width: number;
  height: number;
}

export default function ForceGraph({
  nodes,
  edges,
  onNodeClick,
  onNodeDoubleClick,
  onNodeHover,
  selectedNode,
  centerNodeId,
  width,
  height,
}: ForceGraphProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const simulationRef = useRef<d3.Simulation<GraphNode, GraphEdge> | null>(null);
  const containerRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);

  // Track click timing for manual double-click detection
  const lastClickRef = useRef<{ nodeId: string; time: number } | null>(null);
  const singleClickTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const DOUBLE_CLICK_DELAY = 400; // ms - generous window for double-click

  // Handle node click - delays selection to allow for double-click detection
  const handleNodeClick = useCallback(
    (event: MouseEvent, d: GraphNode) => {
      event.stopPropagation();

      const now = Date.now();
      const lastClick = lastClickRef.current;

      // Check if this is a double-click on the same node
      if (lastClick && lastClick.nodeId === d.id && now - lastClick.time < DOUBLE_CLICK_DELAY) {
        // Double-click detected - cancel pending single click
        if (singleClickTimeoutRef.current) {
          clearTimeout(singleClickTimeoutRef.current);
          singleClickTimeoutRef.current = null;
        }
        lastClickRef.current = null; // Reset for next interaction

        console.log("[ForceGraph] Double-click detected on:", d.metadata.title);
        if (onNodeDoubleClick) {
          onNodeDoubleClick(d);
        }
        return;
      }

      // First click - store time and delay the single-click action
      lastClickRef.current = { nodeId: d.id, time: now };

      // Cancel any pending single click from a different node
      if (singleClickTimeoutRef.current) {
        clearTimeout(singleClickTimeoutRef.current);
      }

      // Delay single click to allow for double-click detection
      singleClickTimeoutRef.current = setTimeout(() => {
        console.log("[ForceGraph] Single-click confirmed on:", d.metadata.title);
        onNodeClick(d);
        singleClickTimeoutRef.current = null;
      }, DOUBLE_CLICK_DELAY);
    },
    [onNodeClick, onNodeDoubleClick]
  );

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (singleClickTimeoutRef.current) {
        clearTimeout(singleClickTimeoutRef.current);
      }
    };
  }, []);

  // Helper function to split text into two lines
  const splitIntoTwoLines = useCallback((text: string, maxCharsPerLine: number): string[] => {
    if (text.length <= maxCharsPerLine) {
      return [text];
    }

    // Try to split at a word boundary near the middle
    const midPoint = Math.floor(maxCharsPerLine);
    let splitPoint = midPoint;

    // Look for a space near the midpoint
    for (let i = midPoint; i > midPoint - 10 && i > 0; i--) {
      if (text[i] === " " || text[i] === "-") {
        splitPoint = i + 1;
        break;
      }
    }

    const line1 = text.substring(0, splitPoint).trim();
    const line2 = text.substring(splitPoint).trim();

    // Truncate second line if needed
    if (line2.length > maxCharsPerLine) {
      return [line1, line2.substring(0, maxCharsPerLine - 3) + "..."];
    }

    return [line1, line2];
  }, []);

  // Initialize graph only when nodes/edges change
  useEffect(() => {
    if (!svgRef.current || nodes.length === 0) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    // Reset node positions so simulation can recenter properly
    nodes.forEach((node) => {
      node.x = undefined;
      node.y = undefined;
      node.fx = null;
      node.fy = null;
    });

    // Fix center node position at the visual center if specified
    if (centerNodeId) {
      const centerNode = nodes.find((n) => n.id === centerNodeId);
      if (centerNode) {
        centerNode.fx = width / 2;
        centerNode.fy = height / 2;
      }
    }

    // Set up zoom behavior
    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on("zoom", (event) => {
        if (containerRef.current) {
          containerRef.current.attr("transform", event.transform.toString());
        }
      });

    svg.call(zoom as any);

    // Reset zoom transform to identity (centered, no zoom)
    svg.call(zoom.transform as any, d3.zoomIdentity);

    // Create container for zoomable content
    const container = svg.append("g");
    containerRef.current = container;

    // Create a deep copy of nodes to avoid mutation issues
    const nodesCopy = nodes.map((n) => ({ ...n }));
    const edgesCopy = edges.map((e) => ({ ...e }));

    // Determine node degrees for radial positioning
    // First-degree: directly connected to query-node
    // Second-degree: connected to first-degree nodes
    const firstDegreeIds = new Set<string>();
    const secondDegreeIds = new Set<string>();

    edgesCopy.forEach((edge) => {
      const sourceId = typeof edge.source === "string" ? edge.source : edge.source.id;
      const targetId = typeof edge.target === "string" ? edge.target : edge.target.id;

      if (sourceId === "query-node" || sourceId === "original-query-node") {
        firstDegreeIds.add(targetId);
      } else if (targetId === "query-node" || targetId === "original-query-node") {
        firstDegreeIds.add(sourceId);
      }
    });

    edgesCopy.forEach((edge) => {
      const sourceId = typeof edge.source === "string" ? edge.source : edge.source.id;
      const targetId = typeof edge.target === "string" ? edge.target : edge.target.id;

      if (
        firstDegreeIds.has(sourceId) &&
        !firstDegreeIds.has(targetId) &&
        targetId !== "query-node" &&
        targetId !== "original-query-node"
      ) {
        secondDegreeIds.add(targetId);
      } else if (
        firstDegreeIds.has(targetId) &&
        !firstDegreeIds.has(sourceId) &&
        sourceId !== "query-node" &&
        sourceId !== "original-query-node"
      ) {
        secondDegreeIds.add(sourceId);
      }
    });

    // Calculate radii based on graph size - clear separation between rings
    const minDimension = Math.min(width, height);
    const firstDegreeRadius = minDimension * 0.18; // Inner ring for first-degree nodes
    const secondDegreeRadius = minDimension * 0.38; // Outer ring for second-degree nodes (2x inner)

    // Set up force simulation with radial organization
    const simulation = d3
      .forceSimulation<GraphNode, GraphEdge>(nodesCopy)
      .force(
        "link",
        d3
          .forceLink<GraphNode, GraphEdge>(edgesCopy)
          .id((d) => d.id)
          .distance((d: any) => {
            // Moderate distances for balanced layout
            const weight = typeof d === "object" && "weight" in d ? d.weight : 0.8;
            return 80 + (1 - weight) * 50;
          })
          .strength(0.8) // Stronger link pull
      )
      .force("charge", d3.forceManyBody().strength(-200)) // Moderate repulsion
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collision", d3.forceCollide().radius(45)) // Smaller collision radius
      // Radial force: pull first-degree to inner ring, second-degree to outer ring
      .force(
        "radial",
        d3
          .forceRadial<GraphNode>(
            (d) => {
              // Only the actual center node at radius 0
              if (d.id === "query-node") return 0;
              // Original query node goes in first-degree ring (it's preserved context)
              if (d.id === "original-query-node") return firstDegreeRadius;
              if (firstDegreeIds.has(d.id)) return firstDegreeRadius;
              if (secondDegreeIds.has(d.id)) return secondDegreeRadius;
              return secondDegreeRadius * 1.2; // Any other nodes go to outer edge
            },
            width / 2,
            height / 2
          )
          .strength(0.6) // Stronger radial pull for clearer rings
      );

    simulationRef.current = simulation;

    // Create edges
    const link = container
      .append("g")
      .attr("class", "links")
      .selectAll("line")
      .data(edgesCopy)
      .enter()
      .append("line")
      .attr("stroke", "#999")
      .attr("stroke-opacity", 0.6)
      .attr("stroke-width", (d) => {
        const weight = typeof d === "object" && "weight" in d ? d.weight : 0.8;
        return Math.max(1, weight * 3);
      });

    // Create node groups (circle + label together)
    const nodeGroups = container
      .append("g")
      .attr("class", "nodes")
      .selectAll("g")
      .data(nodesCopy)
      .enter()
      .append("g")
      .attr("class", "node-group")
      .style("cursor", "pointer");

    // Add halo circle for center node (after recentering)
    nodeGroups
      .filter((d) => !!(centerNodeId && d.id === centerNodeId))
      .append("circle")
      .attr("class", "center-halo")
      .attr("r", 22)
      .attr("fill", "none")
      .attr("stroke", "#f59e0b") // amber/orange color
      .attr("stroke-width", 3)
      .attr("stroke-dasharray", "4,2")
      .attr("opacity", 0.8);

    // Add circles to node groups
    nodeGroups
      .append("circle")
      .attr("r", (d) => {
        if (d.type === "query") return 12;
        if (d.type === "source") return 10;
        return 8;
      })
      .attr("fill", (d) => getNodeColor(d.metadata.contentType, d.type))
      .attr("stroke", (d) => (selectedNode === d.id ? "#000" : "#fff"))
      .attr("stroke-width", (d) => (selectedNode === d.id ? 3 : 2));

    // Add text labels to node groups
    nodeGroups.each(function (d) {
      const group = d3.select(this);
      const maxCharsPerLine = d.type === "query" ? 35 : 25;
      const lines = splitIntoTwoLines(d.label, maxCharsPerLine);
      const fontSize = d.type === "query" ? 11 : 9;
      const offsetY = d.type === "query" ? 20 : d.type === "source" ? 18 : 16;

      const text = group
        .append("text")
        .attr("text-anchor", "middle")
        .attr("font-size", `${fontSize}px`)
        .attr("font-family", "sans-serif")
        .attr("fill", "#333")
        .style("pointer-events", "none")
        .style("user-select", "none");

      lines.forEach((line, index) => {
        text
          .append("tspan")
          .attr("x", 0)
          .attr("y", offsetY + index * (fontSize + 2))
          .text(line);
      });
    });

    // Event handlers for node groups
    nodeGroups
      .on("click", function (event, d) {
        handleNodeClick(event, d);
      })
      .on("mouseover", function (event, d) {
        d3.select(this)
          .select("circle")
          .attr("r", () => {
            if (d.type === "query") return 14;
            if (d.type === "source") return 12;
            return 10;
          });
        // Show title and author in tooltip
        const tooltipText = d.metadata.author ? `${d.metadata.title} — ${d.metadata.author}` : d.metadata.title;
        setTooltip({
          x: event.pageX,
          y: event.pageY,
          text: tooltipText,
        });
        if (onNodeHover) {
          onNodeHover(d);
        }
      })
      .on("mouseout", function (event, d) {
        d3.select(this)
          .select("circle")
          .attr("r", () => {
            if (d.type === "query") return 12;
            if (d.type === "source") return 10;
            return 8;
          });
        setTooltip(null);
        if (onNodeHover) {
          onNodeHover(null);
        }
      });

    // Update positions on simulation tick
    simulation.on("tick", () => {
      link
        .attr("x1", (d: any) => d.source.x)
        .attr("y1", (d: any) => d.source.y)
        .attr("x2", (d: any) => d.target.x)
        .attr("y2", (d: any) => d.target.y);

      nodeGroups.attr("transform", (d: any) => `translate(${d.x || 0}, ${d.y || 0})`);
    });

    // Handle background click to deselect
    svg.on("click", (event) => {
      if (event.target === svgRef.current) {
        onNodeClick(null);
      }
    });

    // Cleanup
    return () => {
      simulation.stop();
      simulationRef.current = null;
    };
  }, [
    nodes,
    edges,
    width,
    height,
    handleNodeClick,
    onNodeClick,
    onNodeHover,
    splitIntoTwoLines,
    centerNodeId,
    selectedNode,
  ]);

  // Update selection styling without restarting simulation
  useEffect(() => {
    if (!containerRef.current) return;

    containerRef.current
      .selectAll<SVGCircleElement, GraphNode>(".node-group circle:not(.center-halo)")
      .attr("stroke", (d) => (selectedNode === d.id ? "#000" : "#fff"))
      .attr("stroke-width", (d) => (selectedNode === d.id ? 3 : 2));
  }, [selectedNode]);

  return (
    <div className="relative w-full h-full">
      <svg ref={svgRef} width={width} height={height} className="border border-gray-200 rounded-lg bg-gray-50">
        <defs>
          <marker
            id="arrowhead"
            markerWidth="10"
            markerHeight="10"
            refX="9"
            refY="3"
            orient="auto"
            markerUnits="strokeWidth"
          >
            <polygon points="0 0, 10 3, 0 6" fill="#999" />
          </marker>
        </defs>
      </svg>
      {tooltip && (
        <div
          className="fixed bg-gray-900 text-white text-xs px-2 py-1 rounded pointer-events-none z-50"
          style={{
            left: `${tooltip.x + 10}px`,
            top: `${tooltip.y - 10}px`,
          }}
        >
          {tooltip.text}
        </div>
      )}
    </div>
  );
}
