// Cloudflare Worker for D1 with FTS5 Full-Text Search
// This worker provides endpoints for searching threads and messages using SQLite FTS5

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // CORS headers for all responses
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      switch (pathname) {
        case '/setup':
          return handleSetup(env.DB, corsHeaders);
        case '/search':
          return handleSearch(request, env.DB, corsHeaders);
        case '/seed':
          return handleSeed(env.DB, corsHeaders);
        case '/status':
          return handleStatus(env.DB, corsHeaders);
        case '/rebuild-fts':
          return handleRebuildFts(env.DB, corsHeaders);
        default:
          return new Response(
            JSON.stringify({
              error: 'Not found',
              endpoints: ['/setup', '/search', '/seed', '/status', '/rebuild-fts']
            }),
            {
              status: 404,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            }
          );
      }
    } catch (error) {
      console.error('Worker error:', error);
      return new Response(
        JSON.stringify({ 
          error: 'Internal server error', 
          message: error.message 
        }), 
        { 
          status: 500, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      );
    }
  }
};

// Setup database tables and FTS5 virtual tables
async function handleSetup(db, corsHeaders) {
  try {
    // Create threads table
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        model_id TEXT,
        user_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        pinned_at DATETIME,
        last_message_at DATETIME,
        deleted_at DATETIME
      )
    `).run();

    // Create messages table
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        model_id TEXT,
        role TEXT NOT NULL,
        user_id TEXT,
        content TEXT NOT NULL,
        prompt_tokens INTEGER DEFAULT 0,
        completion_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        input_neurons INTEGER DEFAULT 0,
        output_neurons INTEGER DEFAULT 0,
        total_neurons INTEGER DEFAULT 0,
        provider_message_id TEXT,
        pinned_at DATETIME,
        feedback TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (thread_id) REFERENCES threads(id)
      )
    `).run();

    // Drop existing FTS tables if they exist (to fix corruption)
    await db.prepare(`DROP TABLE IF EXISTS threads_fts`).run();
    await db.prepare(`DROP TABLE IF EXISTS messages_fts`).run();

    // Create FTS5 virtual table for threads (standalone, not external content)
    await db.prepare(`
      CREATE VIRTUAL TABLE threads_fts USING fts5(
        id UNINDEXED,
        title
      )
    `).run();

    // Create FTS5 virtual table for messages (standalone, not external content)
    await db.prepare(`
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        id UNINDEXED,
        thread_id UNINDEXED,
        content,
        role UNINDEXED
      )
    `).run();

    // Create triggers to keep FTS tables in sync with main tables
    
    // Threads FTS triggers
    await db.prepare(`
      CREATE TRIGGER IF NOT EXISTS threads_fts_insert AFTER INSERT ON threads BEGIN
        INSERT INTO threads_fts(id, title) VALUES (new.id, new.title);
      END
    `).run();

    await db.prepare(`
      CREATE TRIGGER IF NOT EXISTS threads_fts_update AFTER UPDATE ON threads BEGIN
        UPDATE threads_fts SET title = new.title WHERE id = old.id;
      END
    `).run();

    await db.prepare(`
      CREATE TRIGGER IF NOT EXISTS threads_fts_delete AFTER DELETE ON threads BEGIN
        DELETE FROM threads_fts WHERE id = old.id;
      END
    `).run();

    // Messages FTS triggers
    await db.prepare(`
      CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(id, thread_id, content, role) 
        VALUES (new.id, new.thread_id, new.content, new.role);
      END
    `).run();

    await db.prepare(`
      CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages BEGIN
        UPDATE messages_fts SET content = new.content, role = new.role WHERE id = old.id;
      END
    `).run();

    await db.prepare(`
      CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
        DELETE FROM messages_fts WHERE id = old.id;
      END
    `).run();

    // Create indexes for better performance
    await db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id)
    `).run();

    await db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_threads_user_id ON threads(user_id)
    `).run();

    // Rebuild FTS data from existing records
    const existingThreads = await db.prepare('SELECT id, title FROM threads WHERE deleted_at IS NULL').all();
    for (const thread of existingThreads.results) {
      await db.prepare('INSERT INTO threads_fts(id, title) VALUES (?, ?)')
        .bind(thread.id, thread.title).run();
    }

    const existingMessages = await db.prepare('SELECT id, thread_id, content, role FROM messages').all();
    for (const message of existingMessages.results) {
      await db.prepare('INSERT INTO messages_fts(id, thread_id, content, role) VALUES (?, ?, ?, ?)')
        .bind(message.id, message.thread_id, message.content, message.role).run();
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Database setup completed successfully',
        tables_created: ['threads', 'messages', 'threads_fts', 'messages_fts'],
        triggers_created: ['threads_fts_insert', 'threads_fts_update', 'threads_fts_delete', 'messages_fts_insert', 'messages_fts_update', 'messages_fts_delete'],
        fts_rebuilt: {
          threads: existingThreads.results.length,
          messages: existingMessages.results.length
        }
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  } catch (error) {
    console.error('Setup error:', error);
    return new Response(
      JSON.stringify({ 
        error: 'Setup failed', 
        message: error.message 
      }), 
      { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
}

// Search endpoint with FTS5
async function handleSearch(request, db, corsHeaders) {
  const url = new URL(request.url);
  const query = url.searchParams.get('q');
  const type = url.searchParams.get('type') || 'all'; // 'threads', 'messages', or 'all'
  const limit = parseInt(url.searchParams.get('limit') || '10');
  const offset = parseInt(url.searchParams.get('offset') || '0');

  if (!query) {
    return new Response(
      JSON.stringify({ 
        error: 'Missing query parameter "q"',
        example: '/search?q=story&type=all&limit=10&offset=0'
      }), 
      { 
        status: 400, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }

  try {
    const results = {};
    
    // Search threads if requested
    if (type === 'all' || type === 'threads') {
      const threadsQuery = `
        SELECT 
          t.id,
          t.title,
          t.model_id,
          t.user_id,
          t.created_at,
          t.updated_at,
          t.last_message_at,
          tf.rank
        FROM threads_fts tf
        JOIN threads t ON tf.id = t.id
        WHERE threads_fts MATCH ?
        AND t.deleted_at IS NULL
        ORDER BY tf.rank
        LIMIT ? OFFSET ?
      `;
      
      const threadsResult = await db.prepare(threadsQuery)
        .bind(query, limit, offset)
        .all();
      
      results.threads = {
        count: threadsResult.results.length,
        data: threadsResult.results
      };
    }

    // Search messages if requested
    if (type === 'all' || type === 'messages') {
      const messagesQuery = `
        SELECT 
          m.id,
          m.thread_id,
          m.role,
          m.user_id,
          m.content,
          m.created_at,
          t.title as thread_title,
          mf.rank
        FROM messages_fts mf
        JOIN messages m ON mf.id = m.id
        JOIN threads t ON m.thread_id = t.id
        WHERE messages_fts MATCH ?
        AND t.deleted_at IS NULL
        AND m.role != 'system'
        ORDER BY mf.rank
        LIMIT ? OFFSET ?
      `;
      
      const messagesResult = await db.prepare(messagesQuery)
        .bind(query, limit, offset)
        .all();
      
      results.messages = {
        count: messagesResult.results.length,
        data: messagesResult.results
      };
    }

    // Get total counts for pagination
    if (type === 'all' || type === 'threads') {
      const threadsCountResult = await db.prepare(`
        SELECT COUNT(*) as total
        FROM threads_fts tf
        JOIN threads t ON tf.id = t.id
        WHERE threads_fts MATCH ?
        AND t.deleted_at IS NULL
      `).bind(query).first();
      
      results.threads.total = threadsCountResult.total;
    }

    if (type === 'all' || type === 'messages') {
      const messagesCountResult = await db.prepare(`
        SELECT COUNT(*) as total
        FROM messages_fts mf
        JOIN messages m ON mf.id = m.id
        JOIN threads t ON m.thread_id = t.id
        WHERE messages_fts MATCH ?
        AND t.deleted_at IS NULL
        AND m.role != 'system'
      `).bind(query).first();
      
      results.messages.total = messagesCountResult.total;
    }

    return new Response(
      JSON.stringify({
        query,
        type,
        limit,
        offset,
        results
      }), 
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  } catch (error) {
    console.error('Search error:', error);
    return new Response(
      JSON.stringify({ 
        error: 'Search failed', 
        message: error.message 
      }), 
      { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
}

// Seed database with sample data
async function handleSeed(db, corsHeaders) {
  try {
    // Sample threads data
    const sampleThreads = [
      {
        id: 'cefa1417-840b-4a84-af3d-ae57b7246866',
        title: 'Tell me a story',
        model_id: 'deepseek/deepseek-chat-v3-0324',
        user_id: 'user_2x29Kdb5Vs2QJ9a7dBrSxjKAml2'
      },
      {
        id: 'aebc8ca5-e7b3-4e16-87a8-77385587b856',
        title: 'Tell me a joke',
        model_id: 'deepseek/deepseek-chat-v3-0324',
        user_id: 'user_2x29Kdb5Vs2QJ9a7dBrSxjKAml2'
      },
      {
        id: '1014bac0-a40e-4092-b6c1-0e210780c76e',
        title: 'Programming help with JavaScript',
        model_id: 'deepseek/deepseek-chat-v3-0324',
        user_id: 'user_2x29Kdb5Vs2QJ9a7dBrSxjKAml2'
      },
      {
        id: '550e8400-e29b-41d4-a716-446655440000',
        title: 'How to cook pasta',
        model_id: 'deepseek/deepseek-chat-v3-0324',
        user_id: 'user_2x29Kdb5Vs2QJ9a7dBrSxjKAml2'
      }
    ];

    // Sample messages data
    const sampleMessages = [
      {
        id: '3f8f7814-a7ae-4a9c-8530-de669d6bbbfe',
        thread_id: 'cefa1417-840b-4a84-af3d-ae57b7246866',
        role: 'system',
        content: 'You are a helpful assistant.'
      },
      {
        id: '61df5949-f54e-4e03-89d8-aa0d0cee15d9',
        thread_id: 'cefa1417-840b-4a84-af3d-ae57b7246866',
        role: 'user',
        user_id: 'user_2x29Kdb5Vs2QJ9a7dBrSxjKAml2',
        content: 'Tell me a story about a brave knight who saves a village from a dragon.'
      },
      {
        id: '721df949-f54e-4e03-89d8-aa0d0cee15d9',
        thread_id: 'cefa1417-840b-4a84-af3d-ae57b7246866',
        role: 'assistant',
        content: 'Once upon a time, in a small village nestled between rolling hills, there lived a brave knight named Sir Galahad. The village was terrorized by a fearsome dragon that demanded tribute every month. Sir Galahad took up his sword and shield, rode to the dragon\'s lair, and after a fierce battle, convinced the dragon to find a new home far from the village. The villagers celebrated their hero, and peace returned to the land.'
      },
      {
        id: '831df949-f54e-4e03-89d8-aa0d0cee15d9',
        thread_id: 'aebc8ca5-e7b3-4e16-87a8-77385587b856',
        role: 'user',
        user_id: 'user_2x29Kdb5Vs2QJ9a7dBrSxjKAml2',
        content: 'Tell me a programming joke about JavaScript'
      },
      {
        id: '941df949-f54e-4e03-89d8-aa0d0cee15d9',
        thread_id: 'aebc8ca5-e7b3-4e16-87a8-77385587b856',
        role: 'assistant',
        content: 'Why do JavaScript developers prefer dark mode? Because light attracts bugs! 🐛'
      },
      {
        id: 'a51df949-f54e-4e03-89d8-aa0d0cee15d9',
        thread_id: '1014bac0-a40e-4092-b6c1-0e210780c76e',
        role: 'user',
        user_id: 'user_2x29Kdb5Vs2QJ9a7dBrSxjKAml2',
        content: 'How do I implement async/await in JavaScript for API calls?'
      },
      {
        id: 'b61df949-f54e-4e03-89d8-aa0d0cee15d9',
        thread_id: '1014bac0-a40e-4092-b6c1-0e210780c76e',
        role: 'assistant',
        content: 'Here\'s how to use async/await for API calls in JavaScript:\n\nasync function fetchData() {\n  try {\n    const response = await fetch(\'https://api.example.com/data\');\n    const data = await response.json();\n    return data;\n  } catch (error) {\n    console.error(\'Error fetching data:\', error);\n  }\n}\n\nThis pattern makes asynchronous code more readable and easier to debug.'
      },
      {
        id: 'c71df949-f54e-4e03-89d8-aa0d0cee15d9',
        thread_id: '550e8400-e29b-41d4-a716-446655440000',
        role: 'user',
        user_id: 'user_2x29Kdb5Vs2QJ9a7dBrSxjKAml2',
        content: 'What\'s the best way to cook pasta al dente?'
      },
      {
        id: 'd81df949-f54e-4e03-89d8-aa0d0cee15d9',
        thread_id: '550e8400-e29b-41d4-a716-446655440000',
        role: 'assistant',
        content: 'To cook pasta al dente: 1) Use plenty of salted boiling water, 2) Follow package timing but test 1-2 minutes early, 3) The pasta should be firm to the bite with no white center, 4) Reserve pasta water before draining, 5) Finish cooking in the sauce for best results. The key is frequent testing near the end of cooking time!'
      }
    ];

    // Insert threads
    for (const thread of sampleThreads) {
      await db.prepare(`
        INSERT OR REPLACE INTO threads (id, title, model_id, user_id, created_at, updated_at, last_message_at)
        VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'))
      `).bind(thread.id, thread.title, thread.model_id, thread.user_id).run();
    }

    // Insert messages
    for (const message of sampleMessages) {
      await db.prepare(`
        INSERT OR REPLACE INTO messages (id, thread_id, role, user_id, content, created_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
      `).bind(message.id, message.thread_id, message.role, message.user_id || null, message.content).run();
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        message: 'Sample data seeded successfully',
        threads_inserted: sampleThreads.length,
        messages_inserted: sampleMessages.length
      }), 
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  } catch (error) {
    console.error('Seed error:', error);
    return new Response(
      JSON.stringify({ 
        error: 'Seeding failed', 
        message: error.message 
      }), 
      { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
}

// Status endpoint to check database health
async function handleStatus(db, corsHeaders) {
  try {
    // Check table existence and row counts
    const threadsCount = await db.prepare('SELECT COUNT(*) as count FROM threads').first();
    const messagesCount = await db.prepare('SELECT COUNT(*) as count FROM messages').first();
    const threadsFtsCount = await db.prepare('SELECT COUNT(*) as count FROM threads_fts').first();
    const messagesFtsCount = await db.prepare('SELECT COUNT(*) as count FROM messages_fts').first();

    // Test FTS functionality
    const ftsTest = await db.prepare('SELECT COUNT(*) as count FROM threads_fts WHERE threads_fts MATCH ?').bind('story').first();

    return new Response(
      JSON.stringify({
        status: 'healthy',
        database: {
          threads: threadsCount.count,
          messages: messagesCount.count,
          threads_fts: threadsFtsCount.count,
          messages_fts: messagesFtsCount.count
        },
        fts_test: {
          query: 'story',
          matches: ftsTest.count
        },
        endpoints: {
          setup: '/setup - Initialize database tables and FTS',
          search: '/search?q=query&type=all&limit=10&offset=0 - Search content',
          seed: '/seed - Insert sample data',
          status: '/status - Check database status',
          'rebuild-fts': '/rebuild-fts - Rebuild FTS indexes from existing data'
        }
      }), 
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  } catch (error) {
    console.error('Status error:', error);
    return new Response(
      JSON.stringify({ 
        status: 'error',
        error: 'Status check failed', 
        message: error.message 
      }), 
      { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
}

// Rebuild FTS indexes from existing data
async function handleRebuildFts(db, corsHeaders) {
  try {
    // Clear existing FTS data
    await db.prepare('DELETE FROM threads_fts').run();
    await db.prepare('DELETE FROM messages_fts').run();

    // Rebuild threads FTS
    const threads = await db.prepare('SELECT id, title FROM threads WHERE deleted_at IS NULL').all();
    let threadsRebuilt = 0;
    for (const thread of threads.results) {
      await db.prepare('INSERT INTO threads_fts(id, title) VALUES (?, ?)')
        .bind(thread.id, thread.title).run();
      threadsRebuilt++;
    }

    // Rebuild messages FTS
    const messages = await db.prepare('SELECT id, thread_id, content, role FROM messages').all();
    let messagesRebuilt = 0;
    for (const message of messages.results) {
      await db.prepare('INSERT INTO messages_fts(id, thread_id, content, role) VALUES (?, ?, ?, ?)')
        .bind(message.id, message.thread_id, message.content, message.role).run();
      messagesRebuilt++;
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: 'FTS indexes rebuilt successfully',
        rebuilt: {
          threads: threadsRebuilt,
          messages: messagesRebuilt
        }
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  } catch (error) {
    console.error('Rebuild FTS error:', error);
    return new Response(
      JSON.stringify({
        error: 'FTS rebuild failed',
        message: error.message
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
}
