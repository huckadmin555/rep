const WebSocket = require('ws');
const mysql = require('mysql2');
const url = require('url');

// ✅ ИСПОЛЬЗУЕМ ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ RAILWAY
const db = mysql.createPool({
    host: process.env.MYSQLHOST || 'localhost',
    user: process.env.MYSQLUSER || 'root',
    password: process.env.MYSQLPASSWORD || '',
    database: process.env.MYSQLDATABASE || 'salut',
    port: process.env.MYSQLPORT || 3306
});

// ✅ Railway сам назначит порт через переменную PORT
const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });
const clients = new Map();

wss.on('connection', (ws, req) => {
    const parameters = url.parse(req.url, true);
    const userId = parameters.query.user_id;
    
    if (!userId) {
        ws.close();
        return;
    }
    
    clients.set(parseInt(userId), ws);
    console.log(`✅ Пользователь ${userId} подключился`);
    
    broadcastOnlineStatus(userId, true);
    
    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data);
            console.log('📥 Получено сообщение:', message.type);
            
            switch (message.type) {
                case 'message':
                    await handleMessage(message, parseInt(userId));
                    break;
                case 'typing':
                    handleTyping(message, parseInt(userId));
                    break;
                case 'read':
                    console.log('📥 read от userId=', userId, 'данные:', message);
                    await handleRead(message, parseInt(userId));
                    break;
                default:
                    console.log('❓ Неизвестный тип сообщения:', message.type);
            }
        } catch (e) {
            console.error('Ошибка обработки:', e);
        }
    });
    
    ws.on('close', () => {
        clients.delete(parseInt(userId));
        broadcastOnlineStatus(userId, false);
        console.log(`❌ Пользователь ${userId} отключился`);
    });
});

async function handleMessage(data, senderId) {
    const receiver_id = parseInt(data.receiver_id);
    const { message, conversation_id, temp_id } = data;
    
    try {
        let convId = conversation_id;
        
        if (!convId) {
            const [existing] = await db.promise().query(
                `SELECT c.id 
                 FROM conversations c
                 JOIN participants p1 ON c.id = p1.conversation_id AND p1.user_id = ?
                 JOIN participants p2 ON c.id = p2.conversation_id AND p2.user_id = ?
                 WHERE c.type = 'private'`,
                [senderId, receiver_id]
            );
            
            if (existing.length > 0) {
                convId = existing[0].id;
                console.log(`✅ Найден существующий чат: ${convId}`);
            } else {
                const [result] = await db.promise().query(
                    'INSERT INTO conversations (type, created_by, created_at) VALUES (?, ?, NOW())',
                    ['private', senderId]
                );
                convId = result.insertId;
                
                await db.promise().query(
                    'INSERT INTO participants (conversation_id, user_id, role) VALUES (?, ?, ?), (?, ?, ?)',
                    [convId, senderId, 'member', convId, receiver_id, 'member']
                );
                console.log(`🆕 Создан новый чат: ${convId} между ${senderId} и ${receiver_id}`);
            }
        }
        
        const [result] = await db.promise().query(
            'INSERT INTO messages (conversation_id, user_id, content, created_at) VALUES (?, ?, ?, NOW())',
            [convId, senderId, message]
        );
        
        const messageId = result.insertId;
        console.log(`💾 Сообщение ${messageId} сохранено в чат ${convId}`);
        
        const receiverWs = clients.get(receiver_id);
        if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
            receiverWs.send(JSON.stringify({
                type: 'message',
                message_id: messageId,
                conversation_id: convId,
                sender_id: senderId,
                content: message,
                temp_id: temp_id,
                created_at: new Date().toISOString()
            }));
        }
        
    } catch (e) {
        console.error('Ошибка сохранения:', e);
    }
}

function handleTyping(data, senderId) {
    const receiverWs = clients.get(parseInt(data.receiver_id));
    if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
        receiverWs.send(JSON.stringify({
            type: 'typing',
            sender_id: senderId,
            is_typing: data.is_typing
        }));
    }
}

async function handleRead(data, readerId) {
    const { message_ids } = data;
    console.log(`👀 handleRead: readerId=${readerId}, message_ids=`, message_ids);
    
    if (!message_ids || message_ids.length === 0) {
        console.log('❌ Нет message_ids');
        return;
    }
    
    try {
        for (const msgId of message_ids) {
            await db.promise().query(
                'INSERT IGNORE INTO message_reads (message_id, user_id, read_at) VALUES (?, ?, NOW())',
                [msgId, readerId]
            );
        }
        console.log(`✅ Сохранено ${message_ids.length} отметок о прочтении`);
        
        const [rows] = await db.promise().query(
            'SELECT DISTINCT user_id FROM messages WHERE id IN (?) AND user_id != ?',
            [message_ids, readerId]
        );
        
        const senders = rows.map(r => r.user_id);
        console.log(`📤 Отправляем read отправителям:`, senders);
        
        for (const senderId of senders) {
            const senderWs = clients.get(senderId);
            if (senderWs && senderWs.readyState === WebSocket.OPEN) {
                senderWs.send(JSON.stringify({
                    type: 'read',
                    message_ids: message_ids,
                    reader_id: readerId
                }));
                console.log(`✅ read отправлен senderId=${senderId}`);
            } else {
                console.log(`❌ Отправитель ${senderId} не в clients`);
            }
        }
        
    } catch (e) {
        console.error('Ошибка прочтения:', e);
    }
}

function broadcastOnlineStatus(userId, isOnline) {
    const status = {
        type: 'online',
        user_id: parseInt(userId),
        is_online: isOnline
    };
    
    for (const [id, ws] of clients) {
        if (id !== parseInt(userId) && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(status));
        }
    }
}

console.log(`🚀 WebSocket сервер запущен на порту ${PORT}`);