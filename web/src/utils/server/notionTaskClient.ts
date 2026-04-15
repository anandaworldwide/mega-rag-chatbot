import { DownvoteFeedbackCluster } from "@/types/downvoteFeedback";
import { DownvoteFeedbackService } from "@/utils/server/downvoteFeedbackService";

type NotionCreateResponse = {
  id: string;
  url: string;
};

type NotionReuseCandidate = {
  taskId?: string | null;
  taskUrl?: string | null;
};

type NotionRichText = {
  type: "text";
  text: {
    content: string;
    link?: {
      url: string;
    } | null;
  };
};

type NotionBlock =
  | {
      object: "block";
      type: "heading_2";
      heading_2: {
        rich_text: NotionRichText[];
      };
    }
  | {
      object: "block";
      type: "bulleted_list_item";
      bulleted_list_item: {
        rich_text: NotionRichText[];
      };
    }
  | {
      object: "block";
      type: "paragraph";
      paragraph: {
        rich_text: NotionRichText[];
      };
    };

export class NotionTaskClient {
  private readonly apiKey = process.env.NOTION_API_KEY;
  private readonly parentPageId = process.env.NOTION_DOWNVOTE_PARENT_PAGE_ID;
  private readonly taskDatabaseId = process.env.NOTION_DOWNVOTE_TASK_DATABASE_ID;
  private readonly baseUrl = process.env.NEXT_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_SITE_URL || "";

  isConfigured(): boolean {
    return Boolean(this.apiKey && (this.taskDatabaseId || this.parentPageId));
  }

  private getHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    };
  }

  private normalizeStatusValue(status: string): string {
    return status.trim().toLowerCase().replace(/\s+/g, " ");
  }

  private isWorkflowLikePropertyName(propertyName: string): boolean {
    const normalized = propertyName.trim().toLowerCase();
    return normalized.includes("status") || normalized.includes("state") || normalized.includes("stage") || normalized.includes("workflow");
  }

  private extractOptionNames(property: any): string[] {
    if (!property || typeof property !== "object") {
      return [];
    }

    if (property.type === "status") {
      return (property.status?.options || []).map((option: { name?: string }) => option.name).filter(Boolean);
    }

    if (property.type === "select") {
      return (property.select?.options || []).map((option: { name?: string }) => option.name).filter(Boolean);
    }

    if (property.type === "multi_select") {
      return (property.multi_select?.options || []).map((option: { name?: string }) => option.name).filter(Boolean);
    }

    return [];
  }

  private extractTaskStatusFromPage(payload: { properties?: Record<string, any> }): string | null {
    const properties = payload.properties || {};
    const entries = Object.entries(properties);

    const statusProperty =
      entries.find(([, value]) => value?.type === "status") ||
      entries.find(([key, value]) => value?.type === "select" && key.toLowerCase() === "status") ||
      entries.find(([key, value]) => value?.type === "select" && this.isWorkflowLikePropertyName(key)) ||
      entries.find(([key, value]) => value?.type === "multi_select" && this.isWorkflowLikePropertyName(key)) ||
      entries.find(([, value]) => value?.type === "select") ||
      entries.find(([, value]) => value?.type === "multi_select");

    if (!statusProperty) {
      return null;
    }

    const [, value] = statusProperty;
    const rawStatus =
      value?.status?.name ||
      value?.select?.name ||
      (Array.isArray(value?.multi_select) && value.multi_select.length > 0 ? value.multi_select[0]?.name : undefined);
    return typeof rawStatus === "string" ? rawStatus : null;
  }

  async isTaskOpenForReuse(taskId: string): Promise<boolean> {
    if (!this.apiKey || !taskId.trim()) {
      return false;
    }

    const response = await fetch(`https://api.notion.com/v1/pages/${taskId}`, {
      method: "GET",
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Notion task lookup failed (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as { properties?: Record<string, any>; archived?: boolean; in_trash?: boolean };
    if (data.archived || data.in_trash) {
      return false;
    }

    const status = this.extractTaskStatusFromPage(data);
    if (!status) {
      return false;
    }

    const normalized = this.normalizeStatusValue(status);
    if (
      normalized.includes("done") ||
      normalized.includes("verify") ||
      normalized.includes("review") ||
      normalized.includes("test")
    ) {
      return false;
    }

    return normalized === "to do" || normalized === "doing";
  }

  async findReusableTask(candidates: NotionReuseCandidate[]): Promise<NotionCreateResponse | null> {
    const seenTaskIds = new Set<string>();

    for (const candidate of candidates) {
      const taskId = candidate.taskId?.trim();
      const taskUrl = candidate.taskUrl?.trim();
      if (!taskId || !taskUrl || seenTaskIds.has(taskId)) {
        continue;
      }

      seenTaskIds.add(taskId);
      const isOpenTask = await this.isTaskOpenForReuse(taskId);
      if (isOpenTask) {
        return {
          id: taskId,
          url: taskUrl,
        };
      }
    }

    return null;
  }

  private buildText(content: string): NotionRichText[] {
    return content ? [{ type: "text", text: { content: content.slice(0, 1900) } }] : [];
  }

  private buildLinkText(label: string, url: string): NotionRichText[] {
    const safeLabel = label.trim();
    const safeUrl = url.trim();
    if (!safeLabel || !safeUrl) {
      return [];
    }

    return [
      {
        type: "text",
        text: {
          content: safeLabel.slice(0, 1900),
          link: { url: safeUrl },
        },
      },
    ];
  }

  private buildShareUrl(answerDocId?: string): string | null {
    if (!answerDocId?.trim()) {
      return null;
    }

    if (!this.baseUrl) {
      return `/share/${answerDocId}`;
    }

    const normalizedBase = this.baseUrl.replace(/\/+$/, "");
    return `${normalizedBase}/share/${answerDocId}`;
  }

  private buildBlocks(cluster: DownvoteFeedbackCluster): NotionBlock[] {
    const sampleIncidents =
      cluster.sampleIncidents && cluster.sampleIncidents.length > 0
        ? cluster.sampleIncidents
        : cluster.sampleQuestions.slice(0, 3).map((question, index) => ({
            answerDocId: undefined,
            reason: undefined,
            question,
            comment: cluster.sampleComments[index],
          }));

    const blocks: NotionBlock[] = [
      {
        object: "block",
        type: "heading_2",
        heading_2: {
          rich_text: this.buildText("Summary"),
        },
      },
      {
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: {
          rich_text: this.buildText(`Category: ${DownvoteFeedbackService.getCategoryLabel(cluster.triageCategory)}`),
        },
      },
      {
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: {
          rich_text: this.buildText(`Total events: ${cluster.totalEvents}`),
        },
      },
      {
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: {
          rich_text: this.buildText(`Average confidence: ${cluster.averageConfidence.toFixed(2)}`),
        },
      },
      {
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: {
          rich_text: this.buildText(`Recommended action: ${cluster.recommendedAction}`),
        },
      },
      {
        object: "block",
        type: "heading_2",
        heading_2: {
          rich_text: this.buildText("Examples"),
        },
      },
      ...sampleIncidents.flatMap<NotionBlock>((incident, index) => {
        const incidentBlocks: NotionBlock[] = [];
        const parts: string[] = [];

        if (incident.reason) {
          parts.push(`Reason: ${incident.reason}`);
        }
        if (incident.question) {
          parts.push(`Question: ${incident.question}`);
        }
        if (incident.comment) {
          parts.push(`User feedback: ${incident.comment}`);
        }

        if (parts.length > 0) {
          incidentBlocks.push({
            object: "block",
            type: "bulleted_list_item",
            bulleted_list_item: {
              rich_text: this.buildText(`Example ${index + 1} - ${parts.join(" | ")}`),
            },
          });
        }

        const shareUrl = this.buildShareUrl(incident.answerDocId);
        if (shareUrl) {
          incidentBlocks.push({
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: this.buildLinkText(`Open original question and answer (Example ${index + 1})`, shareUrl),
            },
          });
        }

        return incidentBlocks;
      }),
    ];

    return blocks;
  }

  private async getDatabasePropertyConfig(): Promise<{
    titlePropertyName: string;
    workflowPropertyName: string;
    workflowPropertyType: "status" | "select" | "multi_select";
  }> {
    if (!this.taskDatabaseId) {
      throw new Error("NOTION_DOWNVOTE_TASK_DATABASE_ID is not configured");
    }

    const response = await fetch(`https://api.notion.com/v1/databases/${this.taskDatabaseId}`, {
      method: "GET",
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Notion database lookup failed (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as { properties: Record<string, any> };

    const propertyEntries = Object.entries(data.properties || {});
    const titlePropertyEntry = propertyEntries.find(([, value]) => value.type === "title");
    if (!titlePropertyEntry) {
      throw new Error("Notion database does not expose a title property");
    }

    const workflowCandidates = propertyEntries.filter(([, value]) =>
      value.type === "status" || value.type === "select" || value.type === "multi_select"
    );
    const hasToDoOption = (entry: [string, any]) =>
      this.extractOptionNames(entry[1]).some((name) => this.normalizeStatusValue(name) === "to do");

    const workflowPropertyEntry =
      workflowCandidates.find(hasToDoOption) ||
      workflowCandidates.find(([key]) => this.isWorkflowLikePropertyName(key)) ||
      workflowCandidates[0];

    if (!workflowPropertyEntry) {
      throw new Error("Notion database must include a status, select, or multi-select property to set To Do");
    }

    return {
      titlePropertyName: titlePropertyEntry[0],
      workflowPropertyName: workflowPropertyEntry[0],
      workflowPropertyType:
        workflowPropertyEntry[1].type === "status"
          ? "status"
          : workflowPropertyEntry[1].type === "select"
            ? "select"
            : "multi_select",
    };
  }

  async createDraftTask(cluster: DownvoteFeedbackCluster): Promise<NotionCreateResponse | null> {
    if (!this.isConfigured() || !this.apiKey) {
      return null;
    }

    const title = DownvoteFeedbackService.buildNotionTitle(cluster);
    let requestBody: Record<string, unknown>;

    if (this.taskDatabaseId) {
      const databasePropertyConfig = await this.getDatabasePropertyConfig();
      requestBody = {
        parent: {
          type: "database_id",
          database_id: this.taskDatabaseId,
        },
        properties: {
          [databasePropertyConfig.titlePropertyName]: {
            title: this.buildText(title),
          },
          [databasePropertyConfig.workflowPropertyName]:
            databasePropertyConfig.workflowPropertyType === "status"
              ? { status: { name: "To Do" } }
              : databasePropertyConfig.workflowPropertyType === "select"
                ? { select: { name: "To Do" } }
                : { multi_select: [{ name: "To Do" }] },
        },
        children: this.buildBlocks(cluster),
      };
    } else if (this.parentPageId) {
      requestBody = {
        parent: {
          type: "page_id",
          page_id: this.parentPageId,
        },
        properties: {
          title: {
            title: this.buildText(title),
          },
        },
        children: this.buildBlocks(cluster),
      };
    } else {
      return null;
    }

    const response = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Notion draft task creation failed (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as { id: string; url: string };
    return {
      id: data.id,
      url: data.url,
    };
  }
}
