# 🚀 Mega RAG Chatbot - Enterprise Multi-Site AI Knowledge Platform

[![Comprehensive Tests](https://github.com/anandaworldwide/mega-rag-chatbot/actions/workflows/comprehensive-tests.yml/badge.svg)](https://github.com/anandaworldwide/mega-rag-chatbot/actions/workflows/comprehensive-tests.yml)

**An advanced open-source RAG (Retrieval-Augmented Generation) system for building intelligent chatbots that understand
your content.** Transform any organization's knowledge base into an AI-powered assistant that provides accurate,
contextual answers with complete source attribution.

## 🎥 See It In Action

Experience the power of our RAG system across different organizations:

|                       Ananda Members                       |                               Ananda.org                               |                      Crystal Clarity                       |
| :--------------------------------------------------------: | :--------------------------------------------------------------------: | :--------------------------------------------------------: |
| ![Ananda Community Demo](docs/assets/gifs/ananda-demo.gif) | ![Wordpress Integration Demo](docs/assets/gifs/ananda-public-demo.gif) | ![Crystal Clarity Demo](docs/assets/gifs/crystal-demo.gif) |
|       **Multi-format library** - PDFs, audio, video        |            **Public knowledge base** - Accessible resources            |        **Publisher catalog** - Book recommendations        |

## 🚀 Getting Started

Ready to build your AI assistant? Here's what you'll need:

**Prerequisites:** Node.js 20+, Python 3.11, UV, API keys (OpenAI, Pinecone, Firebase)

**Setup Steps:**

1. Clone repo and install dependencies
2. Configure environment variables and API keys
3. Set up your site configuration
4. Ingest your content (PDFs, audio, video, websites, or databases)
5. Launch your chatbot

**[View Complete Setup Guide →](docs/GETTING-STARTED.md)**

## 🎯 Why Choose This RAG System?

### 🏢 Enterprise-Ready Multi-Site Architecture

- **Configure unlimited sites** with unique branding, prompts, and data sources
- **Production deployments** serving 4 different organizations simultaneously
- **Granular access control** with user authentication and content-level permissions
- **White-label ready** with customizable UI, logos, and domain mapping

### 📚 Universal Content Ingestion

- **PDF Documents** - Advanced semantic chunking with spaCy NLP
- **Audio/Video Files** - Whisper-powered transcription with timestamped playback
- **YouTube Content** - Bulk playlist processing and transcript generation
- **Website Crawling** - Intelligent robots.txt-compliant web scraping
- **Database Integration** - Direct WordPress MySQL database synchronization
- **Real-time Updates** - Automated content change detection and re-ingestion

### 🧠 Advanced AI Capabilities

- **Semantic Search** - Vector embeddings with Pinecone for precise content matching
- **Geo-Awareness** - Location-based responses for finding centers and services
- **Context Preservation** - Multi-turn conversations with intelligent question reformulation
- **Conversation History** - AI-generated titles and persistent chat history across devices
- **Streaming Responses** - Real-time answer generation with source attribution
- **Dynamic Follow-up Questions** - AI-generated contextual questions to guide deeper exploration
- **Smart Sharing** - Share specific conversation points with view-only access for recipients
- **Newsletter System** - Engage users with beautiful HTML newsletters featuring one-click unsubscribe

### 🔧 Developer-Friendly Architecture

- **Modern Tech Stack** - Next.js 14, TypeScript, React, Python 3.11 + UV
- **Comprehensive Testing** - 1,600+ TypeScript tests (Jest) and 520+ Python tests (pytest) with integration coverage
- **Production Monitoring** - Built-in analytics, error tracking, and health checks
- **WordPress Plugin** - Drop-in chatbot widget for WordPress sites
- **Docker Ready** - Containerized deployment with environment separation

## 👨‍💻 About the Developer

**Michael Olivier** is the lead architect and developer behind the Mega RAG Chatbot. With expertise in building
production-scale solutions at top-tier internet companies and a track record of shipping 1.0 products from the ground
up, he designed and implemented this multi-site RAG platform to help organizations make their knowledge bases more
accessible through AI. ([LinkedIn](https://www.linkedin.com/in/michaelo/))

## 🌟 Real-World Success Stories

This system powers AI assistants for:

- **Spiritual Organizations** - 7,000+ documents, 1,500+ audio files, 800+ videos
- **Legal Research** - Complex case document analysis and fact discovery
- **Publishing Houses** - Book catalog search and recommendation systems
- **Educational Institutions** - Course material Q&A and resource discovery

## 💡 Perfect For

- **Organizations** wanting to make their knowledge base searchable via AI
- **Developers** building custom RAG applications with proven architecture
- **Enterprises** needing multi-tenant AI systems with security and compliance
- **Content Creators** looking to make their media library more accessible
- **Researchers** requiring precise source attribution and context preservation

## 📖 Documentation

### Getting Started

- **[Getting Started Guide](docs/GETTING-STARTED.md)** - Complete setup instructions, environment configuration, and
  first deployment
- **[Troubleshooting Guide](docs/TROUBLESHOOTING.md)** - Common issues and solutions
- **[WordPress Plugin](wordpress/plugins/ananda-ai-chatbot/README.md)** - Drop-in chatbot widget for WordPress sites

### Architecture & Development

- **[PRD](docs/PRD.md)** - Product Requirements Document outlining features and specifications
- **[Tech Stack](docs/tech-stack.md)** - Overview of technologies used in the project
- **[Backend Structure](docs/backend-structure.md)** - Architecture and organization of backend services
- **[Frontend Guidelines](docs/frontend-guidelines.md)** - Styling and design rules for the frontend
- **[File Structure](docs/file-structure.md)** - Organization of project files and directories
- **[App Flow](docs/app-flow.md)** - Main user flows and interactions

### Security & Testing

- **[Security Guide](docs/SECURITY-README.md)** - Security implementation details and best practices
- **[Testing Guide](docs/TESTS-README.md)** - Testing framework and guidelines
- **[Login Bootstrap](docs/login-bootstrap-guide.md)** - Initial superuser account creation

### Deployment & Management

- **[Deployment Guide](docs/deployment-guide.md)** - Deployment procedures and troubleshooting
- **[Prompt Management](docs/prompt-management.md)** - Environment separation and promotion workflow

## 🏗️ System Architecture

Built on modern, scalable architecture principles:

```text
┌─────────────────────────────────────────────────────────────────┐
│                    FRONTEND LAYER                               │
│  Next.js 14 • React 18 • TypeScript • Tailwind CSS              │
│  WordPress Plugin • Admin Dashboard • Mobile-First UI           │
└─────────────────────────────────────────────────────────────────┘
                                  │
┌─────────────────────────────────────────────────────────────────┐
│                    API GATEWAY                                  │
│  JWT Authentication • Rate Limiting • CORS • Security Headers   │
└─────────────────────────────────────────────────────────────────┘
                                  │
┌─────────────────────────────────────────────────────────────────┐
│                  BACKEND SERVICES                               │
│  LangChain RAG • OpenAI LLM • Streaming • Geo-Awareness         │
│  Data Ingestion • Web Crawler • Audio/Video Processing          │
└─────────────────────────────────────────────────────────────────┘
                                  │
┌─────────────────────────────────────────────────────────────────┐
│                    DATA LAYER                                   │
│  Pinecone Vector DB • Firestore NoSQL • Redis Cache • S3        │
└─────────────────────────────────────────────────────────────────┘
```

### What Makes This Special

- **Battle-Tested in Production** - Serving thousands of users across multiple organizations
- **Zero-Downtime Deployments** - Vercel-optimized with edge function support
- **Intelligent Caching** - Redis-powered performance optimization
- **Mobile-First Design** - Progressive Web App with offline capabilities
- **Extensible Plugin System** - WordPress integration with 50+ configuration options

## ⚡ Key Features

### Intelligent Conversation Management

- **AI-Generated Titles** - Automatic conversation summaries for easy identification
- **Cross-Device Sync** - Conversation history syncs seamlessly across all devices
- **Smart Sharing** - Share specific conversation points with view-only access
- **Star Favorites** - Star important conversations for quick access
- **Flexible Privacy** - Public, private, or temporary conversation modes

### Multi-Site Configuration

Configure unlimited sites with unique personalities:

```json
{
  "ananda-public": {
    "name": "The Ananda.org Chatbot",
    "greeting": "Hi, I'm Vivek. How can I help you?",
    "enableGeoAwareness": true,
    "modelName": "gpt-4o-mini"
  }
}
```

### Intelligent Content Processing

- **Semantic Chunking** - spaCy-powered text segmentation preserving context
- **Smart Overlap** - 20% chunk overlap for seamless information continuity
- **Token Optimization** - 600-token chunks optimized for embedding quality
- **Change Detection** - SHA-256 hashing prevents redundant processing
- **Metadata Enrichment** - Automatic author, category, and source attribution

### Enterprise Security & Scalability

- **JWT Authentication** - Secure user sessions with role-based access
- **Rate Limiting** - Redis-powered request throttling and DDoS protection
- **CORS Security** - Configurable cross-origin policies per site
- **Access Control** - Content-level permissions (public/private/restricted)
- **Email Blacklist** - Superuser-managed, per-site list that blocks logins, invites, and already-active sessions (see [login bootstrap guide](docs/login-bootstrap-guide.md#blocking-users-email-blacklist))
- **Audit Logging** - Comprehensive chat history and user analytics

### Rich Media Integration

- **Audio Playback** - Inline players with transcript synchronization
- **Video Processing** - YouTube integration with timestamp-accurate responses
- **File Security** - S3-backed signed URLs with mobile Safari compatibility
- **Transcription Pipeline** - Whisper AI for high-accuracy speech-to-text

## 📊 Universal Data Ingestion Pipeline

Transform any content type into intelligent, searchable knowledge:

| Source Type            | Features                                        | Use Cases                                |
| ---------------------- | ----------------------------------------------- | ---------------------------------------- |
| **PDF Documents**      | Advanced text extraction, metadata preservation | Legal documents, books, research papers  |
| **Audio Files**        | Whisper AI transcription, speaker detection     | Podcasts, lectures, interviews, meetings |
| **YouTube Videos**     | Bulk playlist processing, subtitle extraction   | Educational content, webinars, talks     |
| **Website Content**    | Intelligent crawling, robots.txt compliance     | Documentation, blogs, knowledge bases    |
| **WordPress Database** | Direct MySQL integration, category mapping      | CMS content, blog archives, libraries    |

**Processing Pipeline Highlights:**

- **Intelligent Chunking** - spaCy NLP ensures semantic coherence across chunk boundaries
- **Duplicate Detection** - SHA-256 hashing prevents redundant processing and storage costs
- **Metadata Enrichment** - Automatic extraction of authors, categories, timestamps, and source attribution
- **Batch Processing** - Optimized for large-scale ingestion with progress tracking and resume capability
- **Quality Assurance** - Built-in validation and error recovery for production reliability

See [Getting Started Guide](docs/GETTING-STARTED.md) for detailed ingestion instructions.

## 🤝 Join Our Community

### Why Contribute?

- **Impact Thousands** - Your code powers AI assistants used by diverse organizations
- **Learn Cutting-Edge AI** - Work with the latest RAG, LLM, and vector database technologies
- **Production Experience** - Contribute to a system handling real-world scale and complexity
- **Open Source Impact** - Help democratize AI-powered knowledge systems

### Get Started Contributing

1. **Fork the Repository** - Start your contribution journey
2. **Set Up Development** - Follow our [Getting Started Guide](docs/GETTING-STARTED.md)
3. **Find Your Focus** - Start with documentation improvements, add tests, or enhance existing features
4. **Submit a PR** - We review all contributions with care and feedback

### Contribution Areas

- **AI/ML Features** - Improve RAG performance, add new LLM integrations
- **Frontend/UX** - Enhance user interface and experience
- **Security** - Strengthen authentication and access control
- **Analytics** - Build better monitoring and insights
- **Integrations** - Connect with new platforms and services
- **Documentation** - Help others understand and use the system

### Community Support

- **[GitHub Discussions](https://github.com/anandaworldwide/mega-rag-chatbot/discussions)** - Ask questions, share
  ideas, get help
- **[Issue Tracker](https://github.com/anandaworldwide/mega-rag-chatbot/issues)** - Report bugs, request features
- **[Documentation](docs/)** - Comprehensive guides for every use case

**Ready to build the future of AI-powered knowledge systems?** We'd love to have you on the team!

## 📞 Need Help?

- **[Getting Started Guide](docs/GETTING-STARTED.md)** - Complete setup instructions
- **[Troubleshooting Guide](docs/TROUBLESHOOTING.md)** - Common issues and solutions
- **[GitHub Discussions](https://github.com/anandaworldwide/mega-rag-chatbot/discussions)** - Community support
- **[Issue Tracker](https://github.com/anandaworldwide/mega-rag-chatbot/issues)** - Bug reports and feature requests

---

**Transform your content into an intelligent AI assistant today!** This battle-tested system handles everything from
data ingestion to production deployment.
