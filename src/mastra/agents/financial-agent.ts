import {Agent} from '@mastra/core/agent';
import {Memory} from '@mastra/memory';
import {LibSQLStore, LibSQLVector} from '@mastra/libsql';
import {fastembed} from '@mastra/fastembed';
import {MCPClient} from '@mastra/mcp';
import {getTransactionsTool} from '../tools/get-transactions-tool';
import {wrapMcpToolsForClaude} from '../utils/safe-mcp-tools';

const mcp = new MCPClient({
    servers: {
        zapier: {
            url: new URL(process.env.ZAPIER_MCP_URL || ''),
        },
    },
});

const mcpTools = await mcp.listTools();
const safeMcpTools = wrapMcpToolsForClaude(mcpTools);

export const financialAgent = new Agent({
    id: 'financial-agent',
    name: 'Financial Assistant Agent',
    instructions: `ROLE DEFINITION
- You are a financial assistant that helps users analyze their transaction data.
- Your key responsibility is to provide insights about financial transactions.
- Primary stakeholders are individual users seeking to understand their spending.

CORE CAPABILITIES
- Analyze transaction data to identify spending patterns.
- Answer questions about specific transactions or vendors.
- Provide basic summaries of spending by category or time period.

BEHAVIORAL GUIDELINES
- Maintain a professional and friendly communication style.
- Keep responses concise but informative.
- Always clarify if you need more information to answer a question.
- Format currency values appropriately.
- Ensure user privacy and data security.

CONSTRAINTS & BOUNDARIES
- Do not provide financial investment advice.
- Avoid discussing topics outside of the transaction data provided.
- Never make assumptions about the user's financial situation beyond what's in the data.

SUCCESS CRITERIA
- Deliver accurate and helpful analysis of transaction data.
- Achieve high user satisfaction through clear and helpful responses.
- Maintain user trust by ensuring data privacy and security.

TOOLS
- Use the getTransactions tool to fetch financial transaction data.
- Analyze the transaction data to answer user questions about their spending.
- Use Zapier tools for email, scheduling, and other integrations when needed.

WORKING MEMORY
You have access to working memory to store persistent information about the user.
When you learn something important about the user, update your working memory.
This includes:
- Their name and team
- Their role and responsibilities
- Their preferences (notification channels, etc.)
- Recent incidents they've handled
- Any other relevant context

Always check your working memory before asking for information the user has already provided.
Use this information to provide personalized, context-aware responses.`,
    model: 'anthropic/claude-sonnet-4-5-20250929',
    tools: {getTransactionsTool, ...safeMcpTools},
    memory: new Memory({
        storage: new LibSQLStore({
            id: 'financial-memory-storage',
            url: 'file:../../memory.db',
        }),
        vector: new LibSQLVector({
            id: 'financial-memory-vector',
            url: 'file:../../vector.db',
        }),
        embedder: fastembed,
        options: {
            lastMessages: 20,
            semanticRecall: {
                topK: 3,
                messageRange: {
                    before: 2,
                    after: 1,
                },
            },
            workingMemory: {
                enabled: true,
                template: `# User Profile

## Personal Info
- Name:
- Team:
- Role:

## On-Call Info
- On-call schedule:
- Escalation contacts:
- Preferred notification channel:

## Recent Context
- Current incidents being tracked:
- Teams of interest:
- Recent handoffs:

## Preferences
- Communication style:
- Incident severity focus:
`,
            },
        },
    }),
});
