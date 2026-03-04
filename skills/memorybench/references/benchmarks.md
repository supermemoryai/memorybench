# Benchmark Datasets Reference

MemoryBench supports multiple benchmark datasets, each designed to test different aspects of memory systems.

## Available Benchmarks

### LoCoMo (Long Conversational Memory)

**Best For:** Chat applications, AI assistants, customer support bots

**Focus:** Long-term conversational memory across multiple sessions spanning days or weeks

**Characteristics:**
- Multiple conversation sessions per user
- Sessions spread across different time periods
- Questions test recall of information from past conversations
- Temporal context is important (when did something happen?)
- Tests ability to maintain context across session boundaries

**Use Cases:**
- Personal AI assistants that remember past conversations
- Customer support systems tracking customer history
- Mental health or coaching bots maintaining long-term context
- Educational assistants remembering student progress

**Example Questions:**
- "What did I tell you about my vacation plans last Tuesday?"
- "When was the last time we discussed my project deadline?"
- "What were my concerns about the new feature we talked about last week?"

**Evaluation Focus:**
- Temporal accuracy (remembering when things were discussed)
- Cross-session recall (connecting information from different conversations)
- Context maintenance (understanding conversation continuity)

---

### LongMemEval (Long Memory Evaluation)

**Best For:** RAG systems, document analysis, knowledge bases

**Focus:** Memory systems handling long documents and complex information retrieval

**Characteristics:**
- Long-form content (documents, articles, reports)
- Complex queries requiring synthesis of multiple pieces of information
- Tests deep understanding and precise retrieval
- Information dense environments
- Multi-hop reasoning (connecting information from different parts)

**Use Cases:**
- Document Q&A systems
- Research assistants processing academic papers
- Legal document analysis
- Technical documentation search
- Knowledge base systems for enterprises

**Example Questions:**
- "According to the research paper, what methodology did they use for data collection?"
- "What were the three main recommendations in the executive summary?"
- "How does the proposed solution address the scalability concerns mentioned earlier?"

**Evaluation Focus:**
- Retrieval precision (finding exact relevant information)
- Information synthesis (combining details from multiple sources)
- Long-form context handling (processing extensive documents)
- Accuracy of extracted details

---

### ConvoMem (Conversational Memory)

**Best For:** Dialogue systems, interview bots, meeting assistants

**Focus:** Multi-turn conversation understanding and context tracking within single sessions

**Characteristics:**
- Single extended conversation sessions
- Questions test understanding of conversation flow
- Reference resolution (pronouns, implicit context)
- Turn-by-turn context awareness
- Understanding conversational dynamics

**Use Cases:**
- Interview bots (job interviews, user research)
- Meeting summarization and Q&A
- Therapy or counseling chatbots
- Interactive storytelling systems
- Negotiation or sales dialogue systems

**Example Questions:**
- "What did I say about my experience with Python?"
- "Why did I mention that I preferred the second option?"
- "What was my main concern when you suggested the alternative approach?"

**Evaluation Focus:**
- Within-conversation recall
- Reference resolution (understanding what "it", "that", "then" refer to)
- Conversational flow understanding
- Context tracking across turns

---

## Benchmark Comparison

| Aspect | LoCoMo | LongMemEval | ConvoMem |
|--------|--------|-------------|----------|
| **Time Span** | Days/weeks | Variable | Single session |
| **Content Type** | Multi-session chats | Long documents | Single conversation |
| **Primary Challenge** | Temporal context | Information density | Reference resolution |
| **Typical Use** | Personal assistants | RAG/search | Dialogue systems |
| **Session Count** | Multiple | Multiple documents | Single |
| **Question Focus** | When & across sessions | What & synthesis | Within session context |

## How Benchmarks Work

### Data Format

All benchmarks provide data in the `UnifiedSession` format:

```typescript
interface UnifiedSession {
  sessionId: string
  messages: Array<{
    role: 'user' | 'assistant'
    content: string
  }>
  metadata?: {
    date?: string           // ISO format
    formattedDate?: string  // Human readable
    [key: string]: any
  }
}
```

### Benchmark Pipeline

1. **Ingest Phase**
   - Benchmark sessions are loaded
   - Passed to provider's `ingest()` method
   - Provider stores them in their memory system

2. **Index Phase**
   - Provider's `awaitIndexing()` waits for async processing
   - Ensures all data is searchable before testing

3. **Search Phase**
   - For each question, provider's `search()` is called
   - Provider returns relevant memories/context

4. **Answer Phase**
   - LLM generates answer using retrieved context
   - Uses provider's custom prompts if specified

5. **Evaluate Phase**
   - Judge LLM compares answer to ground truth
   - Scores correctness (0-1 scale)

6. **Report Phase**
   - Aggregate scores across all questions
   - Calculate accuracy, latency, success rate

### Evaluation Metrics

**Accuracy**
- Percentage of questions answered correctly
- Based on judge LLM comparison with ground truth
- Scored 0-1 per question, averaged across all questions

**Latency**
- Search time per question
- Answer generation time
- Total time per question

**Success Rate**
- Percentage of questions that didn't error
- Excludes failures from accuracy calculation

## Choosing the Right Benchmark

### Choose LoCoMo if:
- Your system manages user conversations over time
- You need temporal context (dates, times, order of events)
- Users have multiple sessions/interactions
- You're building a personal assistant or support system

### Choose LongMemEval if:
- Your system processes documents or long-form content
- You need precise information retrieval
- Your use case involves RAG or search
- You work with information-dense content

### Choose ConvoMem if:
- Your system handles single conversation sessions
- You need strong reference resolution
- Your use case is dialogue-focused
- You track context within conversations

### Or Choose Multiple
You can benchmark on all three to get a complete picture of your system's strengths and weaknesses.

## Dataset Size

Typical dataset sizes:
- **LoCoMo**: ~100 questions
- **LongMemEval**: ~150 questions
- **ConvoMem**: ~80 questions

Small run (5 questions): Good for quick validation
Medium run (20 questions): Decent sample size for initial insights
Full run: Complete evaluation, most accurate results

## Running Benchmarks

The skill handles this automatically, but for manual runs:

```bash
cd memorybench

# Single benchmark
bun run src/index.ts run -p yourprovider -b locomo

# Compare multiple providers
bun run src/index.ts compare -p yourprovider,supermemory,mem0 -b longmemeval

# Limited questions
bun run src/index.ts run -p yourprovider -b convomem -l 20

# Different judge model
bun run src/index.ts run -p yourprovider -b locomo -j sonnet-4
```

## Interpreting Results

### Good Scores
- **80%+ accuracy**: Excellent performance, production-ready
- **70-80% accuracy**: Good performance, some room for improvement
- **60-70% accuracy**: Adequate, may need optimization
- **<60% accuracy**: Significant issues, needs investigation

### Common Patterns
- **High LoCoMo, low LongMemEval**: Good at temporal context, struggles with dense information
- **High LongMemEval, low LoCoMo**: Good at search, struggles with temporal/multi-session
- **High ConvoMem, low LoCoMo**: Good within-session, struggles cross-session

### Latency Expectations
- **<100ms search**: Excellent (vector search level)
- **100-300ms search**: Good (typical API latency)
- **300-500ms search**: Adequate (acceptable for most use cases)
- **>500ms search**: Slow (may need optimization)

## Next Steps After Benchmarking

Based on results:
1. **Identify weaknesses**: Which question types failed?
2. **Analyze failures**: `bun run src/index.ts show-failures -r {run-id}`
3. **Iterate**: Adjust retrieval, prompts, or indexing strategy
4. **Re-benchmark**: Run again to measure improvements
5. **Compare**: Try different benchmarks to understand strengths

See [Debugging Reference](debugging.md) for troubleshooting specific issues.
