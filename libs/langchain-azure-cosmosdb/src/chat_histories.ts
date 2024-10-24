import { Container, CosmosClient, CosmosClientOptions } from "@azure/cosmos";
import { DefaultAzureCredential, TokenCredential } from "@azure/identity";
import { BaseListChatMessageHistory } from "@langchain/core/chat_history";
import { BaseMessage, mapChatMessagesToStoredMessages, mapStoredMessagesToChatMessages } from "@langchain/core/messages";
import { getEnvironmentVariable } from "@langchain/core/utils/env";

const USER_AGENT_SUFFIX = "LangChain-CDBNoSQL-ChatHistory-JavaScript";

export interface AzureCosmosDBNoSQLChatMessageHistoryInput {
    sessionId: string;
    userId: string;
    container?: Container;
    client?: CosmosClient;
    connectionString?: string;
    endpoint?: string;
    databaseName?: string;
    containerName?: string;
    credentials?: TokenCredential;
    ttl?: number;
}

export class AzureCosmsosDBNoSQLChatMessageHistory extends BaseListChatMessageHistory {
    lc_namespace = ["langchain", "stores", "message", "azurecosmosdb"];
    private container: Container;
    private sessionId: string;
    private databaseName: string;
    private containerName: string;
    private client: CosmosClient;
    private userId: string;
    private ttl: number | undefined;

    private messageList: BaseMessage[] = [];

    constructor(chatHistoryInput: AzureCosmosDBNoSQLChatMessageHistoryInput) {
        super();

        this.sessionId = chatHistoryInput.sessionId;
        this.databaseName = chatHistoryInput.databaseName ?? "default";
        this.containerName = chatHistoryInput.containerName ?? "default";
        this.userId = chatHistoryInput.userId;
        this.ttl = chatHistoryInput.ttl;
        if (chatHistoryInput.container) {
            this.container = chatHistoryInput.container;
        } else
            this.client = this.initializeClient(chatHistoryInput);
    }

    private initializeClient(input: AzureCosmosDBNoSQLChatMessageHistoryInput): CosmosClient {
        const connectionString = input.connectionString ?? getEnvironmentVariable("AZURE_COSMOSDB_NOSQL_CONNECTION_STRING");
        const endpoint = input.endpoint ?? getEnvironmentVariable("AZURE_COSMOSDB_NOSQL_ENDPOINT");

        if (!input.client && !connectionString && !endpoint) {
            throw new Error("CosmosClient, connection string, or endpoint must be provided.");
        }

        if (input.client) {
            return input.client;
        }

        if (connectionString) {
            const [endpointPart, keyPart] = connectionString.split(";");
            const endpoint = endpointPart.split("=")[1];
            const key = keyPart.split("=")[1];

            return new CosmosClient({
                endpoint,
                key,
                userAgentSuffix: USER_AGENT_SUFFIX,
            });
        } else {
            return new CosmosClient({
                endpoint,
                aadCredentials: input.credentials ?? new DefaultAzureCredential(),
                userAgentSuffix: USER_AGENT_SUFFIX,
            } as CosmosClientOptions);
        }
    }

    private async initializeContainer(): Promise<void> {
        const { database } = await this.client.databases.createIfNotExists({ id: this.databaseName });
        const { container } = await database.containers.createIfNotExists({
            id: this.containerName,
            partitionKey: "/user_id",
            defaultTtl: this.ttl,
        });

        this.container = container;
    }

    async getMessages(): Promise<BaseMessage[]> {
        await this.initializeContainer();
        const document = await this.container.item(this.sessionId, this.userId).read();
        const messages = document.resource?.messages || [];
        return mapStoredMessagesToChatMessages(messages);
    }

    async addMessage(message: BaseMessage): Promise<void> {
        await this.initializeContainer();
        this.messageList = await this.getMessages();
        this.messageList.push(message);
        const messages = mapChatMessagesToStoredMessages(this.messageList);
        await this.container.items.upsert({
            id: this.sessionId,
            user_id: this.userId,
            messages,
        });
    }

    async clear(): Promise<void> {
        this.messageList = [];
        await this.initializeContainer();
        await this.container.item(this.sessionId, this.userId).delete();
    }
}