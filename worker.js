// Cloudflare Workers Telegram 双向消息转发机器人
// 无状态设计 - 不依赖内存存储，Worker重启不影响功能
// 环境变量配置 - 在Cloudflare Workers控制台中设置以下变量：
// BOT_TOKEN: Telegram Bot Token (从 @BotFather 获取)
// ADMIN_CHAT_ID: 管理员的Chat ID (可以通过发送消息给机器人获取)
// WEBHOOK_SECRET: Webhook验证密钥 (可选，用于安全验证)
// ENABLE_USER_TRACKING: 启用用户跟踪 (可选，需要绑定KV存储)
// USER_ID_SECRET: 用户ID签名密钥 (建议设置，用于防止身份伪造攻击)
// ENABLE_FORUM_MODE: 启用论坛话题模式 (可选，当管理员聊天为论坛群组时启用)

// 常量定义
const CONSTANTS = {
  MAX_USERS_LIMIT: 1000,
  BROADCAST_BATCH_SIZE: 10,
  BROADCAST_DELAY_MS: 100,
  API_TIMEOUT_MS: 30000,
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 1000,
  TELEGRAM_API_BASE: 'https://api.telegram.org/bot',
  DEFAULT_ICON_COLORS: [0x6FB9F0, 0xFFD67E, 0xCB86DB, 0x6EBF95, 0xFFB3BA, 0x87CEFA],
  MAX_ERROR_DISPLAY: 5,
  MAX_RECENT_USERS: 20,
  USERS_DEFAULT_PAGE_SIZE: 20,
  USERS_PAGE_SIZES: [10, 20, 50],
  VERIFICATION_TIMEOUT_MS: 24 * 60 * 60 * 1000 // 24 hours in milliseconds
};

// 验证环境变量
function validateEnvironment(env) {
  const required = ['BOT_TOKEN', 'ADMIN_CHAT_ID'];
  const missing = required.filter(key => !env[key]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  
  if (!/^-?\d+$/.test(env.ADMIN_CHAT_ID)) {
    throw new Error('ADMIN_CHAT_ID must be a valid integer');
  }
  
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(env.BOT_TOKEN)) {
    throw new Error('BOT_TOKEN format is invalid');
  }
}

// 输入验证函数
function validateInput(input, type, options = {}) {
  switch (type) {
    case 'message':
      if (!input || typeof input !== 'object') {
        throw new Error('Invalid message object');
      }
      if (!input.from || !input.chat) {
        throw new Error('Message missing required fields');
      }
      break;
    
    case 'chatId':
      if (!input || !/^-?\d+$/.test(input.toString())) {
        throw new Error('Invalid chat ID format');
      }
      break;
    
    case 'text':
      if (typeof input !== 'string') {
        throw new Error('Text must be a string');
      }
      if (options.maxLength && input.length > options.maxLength) {
        throw new Error(`Text exceeds maximum length of ${options.maxLength}`);
      }
      break;
    
    case 'userId':
      if (!input || !/^\d+$/.test(input.toString())) {
        throw new Error('Invalid user ID format');
      }
      break;
    
    default:
      throw new Error(`Unknown validation type: ${type}`);
  }
}

// 增强的日志记录函数
function logError(context, error, additionalInfo = {}) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    context,
    error: {
      message: error.message,
      stack: error.stack,
      name: error.name
    },
    ...additionalInfo
  };
  
  console.error('ERROR:', JSON.stringify(logEntry, null, 2));
}

function logInfo(context, message, additionalInfo = {}) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    context,
    message,
    ...additionalInfo
  };
  
  console.log('INFO:', JSON.stringify(logEntry, null, 2));
}

// 重试机制
async function withRetry(operation, context, maxRetries = CONSTANTS.MAX_RETRIES) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === maxRetries) {
        logError(context, error, { attempt, maxRetries });
        throw error;
      }
      
      logInfo(context, `Attempt ${attempt} failed, retrying...`, { 
        error: error.message, 
        nextAttempt: attempt + 1 
      });
      
      await new Promise(resolve => setTimeout(resolve, CONSTANTS.RETRY_DELAY_MS * attempt));
    }
  }
}

// 检测聊天是否为论坛群组
async function isForum(chatId, botToken) {
  try {
    validateInput(chatId, 'chatId');
    
    const chat = await callTelegramAPI('getChat', { chat_id: chatId }, botToken);
    return chat.ok && chat.result.is_forum === true;
  } catch (error) {
    logError('isForum', error, { chatId });
    return false;
  }
}

// 获取论坛话题列表
async function getForumTopics(chatId, botToken) {
  try {
    validateInput(chatId, 'chatId');
    
    const topics = await callTelegramAPI('getForumTopicIconStickers', { chat_id: chatId }, botToken);
    return topics.ok ? topics.result : [];
  } catch (error) {
    logError('getForumTopics', error, { chatId });
    return [];
  }
}

// 创建论坛话题
async function createForumTopic(chatId, name, iconColor, botToken) {
  try {
    validateInput(chatId, 'chatId');
    validateInput(name, 'text', { maxLength: 128 });
    
    const result = await callTelegramAPI('createForumTopic', {
      chat_id: chatId,
      name: name,
      icon_color: iconColor || CONSTANTS.DEFAULT_ICON_COLORS[0]
    }, botToken);
    
    return result;
  } catch (error) {
    logError('createForumTopic', error, { chatId, name, iconColor });
    return { ok: false, error: error.message };
  }
}

// 从KV存储获取用户话题映射
async function getUserTopicMapping(env) {
  try {
    if (!env.USER_STORAGE) {
      return {};
    }
    
    const mapping = await env.USER_STORAGE.get('user_topic_mapping');
    const parsed = mapping ? JSON.parse(mapping) : {};
    
    if (typeof parsed !== 'object' || parsed === null) {
      logError('getUserTopicMapping', new Error('Invalid mapping data structure'));
      return {};
    }
    
    return parsed;
  } catch (error) {
    logError('getUserTopicMapping', error);
    return {};
  }
}

// 保存用户话题映射到KV存储
async function saveUserTopicMapping(mapping, env) {
  try {
    if (!env.USER_STORAGE) return;
    
    if (typeof mapping !== 'object' || mapping === null) {
      throw new Error('Invalid mapping data structure');
    }
    
    await env.USER_STORAGE.put('user_topic_mapping', JSON.stringify(mapping));
  } catch (error) {
    logError('saveUserTopicMapping', error);
  }
}

// 从话题ID反向查找用户ID
async function getUserIdFromTopicId(topicId, env) {
  try {
    if (!topicId || typeof topicId !== 'number') {
      throw new Error('Invalid topic ID');
    }
    
    const mapping = await getUserTopicMapping(env);
    
    for (const [userId, userTopicId] of Object.entries(mapping)) {
      if (userTopicId === topicId) {
        return userId;
      }
    }
    
    return null;
  } catch (error) {
    logError('getUserIdFromTopicId', error, { topicId });
    return null;
  }
}

// 为用户创建或获取话题
async function getOrCreateUserTopic(userId, userName, env) {
  if (env.ENABLE_FORUM_MODE !== 'true') return null;
  
  try {
    validateInput(userId, 'userId');
    validateInput(userName, 'text', { maxLength: 64 });
    
    const mapping = await getUserTopicMapping(env);
    
    if (mapping[userId]) {
      return mapping[userId];
    }
    
    const topicName = `💬 ${userName} (${userId})`;
    const randomColor = CONSTANTS.DEFAULT_ICON_COLORS[
      Math.floor(Math.random() * CONSTANTS.DEFAULT_ICON_COLORS.length)
    ];
    
    const result = await createForumTopic(env.ADMIN_CHAT_ID, topicName, randomColor, env.BOT_TOKEN);
    
    if (result.ok) {
      const topicId = result.result.message_thread_id;
      mapping[userId] = topicId;
      await saveUserTopicMapping(mapping, env);
      
      logInfo('topicCreated', 'User topic created', { userId, userName, topicId });
      return topicId;
    }
    
    logError('getOrCreateUserTopic', new Error('Failed to create topic'), { result });
    return null;
  } catch (error) {
    logError('getOrCreateUserTopic', error, { userId, userName });
    return null;
  }
}

// 生成用户ID的HMAC签名
async function generateUserIdSignature(userId, secret) {
  try {
    validateInput(userId, 'userId');
    
    if (!secret) {
      const data = new TextEncoder().encode(`user:${userId}:fallback`);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
    }
    
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    
    const data = new TextEncoder().encode(`user:${userId}`);
    const signature = await crypto.subtle.sign('HMAC', key, data);
    const signatureArray = Array.from(new Uint8Array(signature));
    return signatureArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
  } catch (error) {
    logError('generateUserIdSignature', error, { userId });
    throw error;
  }
}

// 验证用户ID签名
async function verifyUserIdSignature(userId, signature, secret) {
  try {
    const expectedSignature = await generateUserIdSignature(userId, secret);
    return signature === expectedSignature;
  } catch (error) {
    logError('verifyUserIdSignature', error, { userId, signature });
    return false;
  }
}

// 创建安全的用户标识符（可点击链接）
async function createSecureUserTag(userId, secret, username = null) {
  try {
    const signature = await generateUserIdSignature(userId, secret);
    
    if (username) {
      return `[@${username} (${userId}:${signature})](https://t.me/${username})`;
    } else {
      return `[👤 USER:${userId}:${signature}](tg://user?id=${userId})`;
    }
  } catch (error) {
    logError('createSecureUserTag', error, { userId });
    
    if (username) {
      return `[@${username}](https://t.me/${username})`;
    } else {
      return `[👤 USER:${userId}](tg://user?id=${userId})`;
    }
  }
}

// 从消息中安全提取用户Chat ID的辅助函数
async function extractUserChatId(messageText, secret) {
  try {
    if (!messageText || typeof messageText !== 'string') return null;
    
    const usernameMatch = messageText.match(/\[@\w+ \((\d+):([a-f0-9]{16})\)\]\(https:\/\/t\.me\/\w+\)/);
    if (usernameMatch) {
      const userId = usernameMatch[1];
      const signature = usernameMatch[2];
      
      const isValid = await verifyUserIdSignature(userId, signature, secret);
      if (isValid) {
        return userId;
      } else {
        logError('extractUserChatId', new Error('Invalid signature'), { userId, signature });
        return null;
      }
    }
    
    const legacyUsernameMatch = messageText.match(/\[@(\w+)\]\(https:\/\/t\.me\/\w+\)/);
    if (legacyUsernameMatch && !usernameMatch) {
      logInfo('extractUserChatId', 'Using legacy username format, cannot extract user ID from username only');
      return null;
    }
    
    const clickableLinkMatch = messageText.match(/\[👤 USER:(\d+):([a-f0-9]{16})\]\(tg:\/\/user\?id=\d+\)/);
    if (clickableLinkMatch) {
      const userId = clickableLinkMatch[1];
      const signature = clickableLinkMatch[2];
      
      const isValid = await verifyUserIdSignature(userId, signature, secret);
      if (isValid) {
        return userId;
      } else {
        logError('extractUserChatId', new Error('Invalid signature'), { userId, signature });
        return null;
      }
    }
    
    const legacyClickableMatch = messageText.match(/\[👤 USER:(\d+)\]\(tg:\/\/user\?id=\d+\)/);
    if (legacyClickableMatch && !clickableLinkMatch) {
      logInfo('extractUserChatId', 'Using legacy clickable format', { userId: legacyClickableMatch[1] });
      return legacyClickableMatch[1];
    }
    
    const secureMatch = messageText.match(/\[USER:(\d+):([a-f0-9]{16})\]/);
    if (secureMatch) {
      const userId = secureMatch[1];
      const signature = secureMatch[2];
      
      const isValid = await verifyUserIdSignature(userId, signature, secret);
      if (isValid) {
        return userId;
      } else {
        logError('extractUserChatId', new Error('Invalid signature'), { userId, signature });
        return null;
      }
    }
    
    const legacyMatch = messageText.match(/\[USER:(\d+)\](?![:\w])/);
    if (legacyMatch && !secureMatch && !clickableLinkMatch && !legacyClickableMatch && !usernameMatch) {
      logInfo('extractUserChatId', 'Using legacy format', { userId: legacyMatch[1] });
      return legacyMatch[1];
    }
    
    return null;
  } catch (error) {
    logError('extractUserChatId', error, { messageText });
    return null;
  }
}

// 解析群发命令的目标用户
function parsePostTargets(commandText) {
  if (!commandText) return { userIds: [], message: '' }
  
  const parts = commandText.split(' ')
  if (parts.length < 2) return { userIds: [], message: '' }
  
  const targetsStr = parts[0]
  const message = parts.slice(1).join(' ')
  
  if (targetsStr === 'all') {
    return { userIds: 'all', message }
  }
  
  const userIds = targetsStr.split(',')
    .map(id => id.trim())
    .filter(id => /^\d+$/.test(id))
  
  return { userIds, message }
}

// 从KV存储获取用户列表
async function getUsersFromKV(env) {
  try {
    if (!env.USER_STORAGE) {
      logInfo('getUsersFromKV', 'KV storage not configured');
      return [];
    }
    
    const usersData = await env.USER_STORAGE.get('user_list');
    if (!usersData) return [];
    
    const users = JSON.parse(usersData);
    
    if (!Array.isArray(users)) {
      logError('getUsersFromKV', new Error('Invalid users data structure'));
      return [];
    }
    
    return users;
  } catch (error) {
    logError('getUsersFromKV', error);
    return [];
  }
}

// 从KV存储获取单个用户
async function getUserFromKV(chatId, env) {
  try {
    if (!env.USER_STORAGE) {
      return null;
    }
    const users = await getUsersFromKV(env);
    return users.find(u => u.chatId === chatId) || null;
  } catch (error) {
    logError('getUserFromKV', error, { chatId });
    return null;
  }
}

// 更新KV中的用户数据
async function updateUserInKV(userData, env) {
  try {
    if (!env.USER_STORAGE) return;
    const users = await getUsersFromKV(env);
    const userIndex = users.findIndex(u => u.chatId === userData.chatId);

    if (userIndex > -1) {
      users[userIndex] = { ...users[userIndex], ...userData };
    } else {
      users.push(userData);
    }
    await env.USER_STORAGE.put('user_list', JSON.stringify(users));
  } catch (error) {
    logError('updateUserInKV', error, { chatId: userData.chatId });
  }
}


// 向KV存储添加用户
async function addUserToKV(chatId, userInfo, env) {
  try {
    if (!env.USER_STORAGE) return;
    
    validateInput(chatId, 'chatId');
    validateInput(userInfo.userName, 'text', { maxLength: 100 });
    validateInput(userInfo.userId, 'userId');
    
    const users = await getUsersFromKV(env);
    const existingIndex = users.findIndex(u => u.chatId === chatId);
    
    const userData = {
      chatId,
      userName: userInfo.userName,
      username: userInfo.username,
      userId: userInfo.userId,
      lastActive: new Date().toISOString()
    };
    
    if (existingIndex >= 0) {
      users[existingIndex] = { ...users[existingIndex], ...userData };
    } else {
      userData.verified = false;
      userData.firstMessageSent = false;
      users.push(userData);
    }
    
    if (users.length > CONSTANTS.MAX_USERS_LIMIT) {
      users.sort((a, b) => new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime());
      users.splice(CONSTANTS.MAX_USERS_LIMIT);
    }
    
    await env.USER_STORAGE.put('user_list', JSON.stringify(users));
    logInfo('addUserToKV', 'User added/updated', { chatId, userName: userInfo.userName });
  } catch (error) {
    logError('addUserToKV', error, { chatId, userInfo });
  }
}

// 改进的群发媒体消息发送函数
async function sendMediaBroadcastToUser(userChatId, adminChatId, messageId, broadcastMessage, botToken) {
  const broadcastPrefix = '📢 管理员广播:';
  
  try {
    const escapedBroadcastMessage = escapeMarkdown(broadcastMessage);
    const fullCaption = `${broadcastPrefix}\n\n${escapedBroadcastMessage}`;
    
    const finalCaption = fullCaption.length > 1024 
      ? `${broadcastPrefix}\n\n${escapedBroadcastMessage.substring(0, 1024 - broadcastPrefix.length - 4)}...`
      : fullCaption;
    
    const result = await copyMessage(userChatId, adminChatId, messageId, botToken, {
      caption: finalCaption
    });
    
    if (result.ok) {
      return result;
    }
    
    logInfo('sendMediaBroadcastToUser', 'Caption failed, sending separately', { 
      error: result.description,
      userChatId 
    });
    
    await sendMessage(userChatId, fullCaption, botToken);
    
    return await copyMessage(userChatId, adminChatId, messageId, botToken);
    
  } catch (error) {
    logError('sendMediaBroadcastToUser', error, { userChatId, messageId });
    
    try {
      const escapedBroadcastMessage = escapeMarkdown(broadcastMessage);
      await sendMessage(userChatId, `${broadcastPrefix}\n\n${escapedBroadcastMessage}\n\n📎 管理员还发送了一个文件`, botToken);
      return await copyMessage(userChatId, adminChatId, messageId, botToken);
    } catch (fallbackError) {
      logError('sendMediaBroadcastToUser', fallbackError, { userChatId, messageId, stage: 'fallback' });
      throw fallbackError;
    }
  }
}

// 群发消息功能
async function broadcastMessage(userIds, message, env, isMedia = false, mediaOptions = {}) {
  const results = { success: 0, failed: 0, errors: [] };
  
  try {
    validateInput(message, 'text', { maxLength: 4096 });
    
    let targetUserIds = [];
    if (userIds === 'all') {
      const users = await getUsersFromKV(env);
      targetUserIds = users.filter(u => u.verified).map(u => u.chatId);
      if (targetUserIds.length === 0) {
        return { 
          success: 0, 
          failed: 1, 
          errors: ['未找到可广播的已验证用户'] 
        };
      }
    } else {
      targetUserIds = Array.isArray(userIds) ? userIds : [userIds];
    }
    
    if (targetUserIds.length === 0) {
      return { success: 0, failed: 1, errors: ['未指定有效的用户ID'] };
    }
    
    const validUserIds = targetUserIds.filter(id => {
      try {
        validateInput(id, 'chatId');
        return true;
      } catch (error) {
        results.errors.push(`无效的用户ID: ${id}`);
        results.failed++;
        return false;
      }
    });
    
    logInfo('broadcastMessage', 'Starting broadcast', { 
      totalUsers: validUserIds.length, 
      isMedia, 
      messageLength: message.length 
    });
    
    for (let i = 0; i < validUserIds.length; i += CONSTANTS.BROADCAST_BATCH_SIZE) {
      const batch = validUserIds.slice(i, i + CONSTANTS.BROADCAST_BATCH_SIZE);
      
      const promises = batch.map(async (chatId) => {
        try {
          if (isMedia) {
            await sendMediaBroadcastToUser(chatId, env.ADMIN_CHAT_ID, mediaOptions.messageId, message, env.BOT_TOKEN);
          } else {
            const escapedMessage = escapeMarkdown(message);
            await sendMessage(chatId, `📢 *管理员广播:*\n\n${escapedMessage}`, env.BOT_TOKEN);
          }
          results.success++;
        } catch (error) {
          results.failed++;
          results.errors.push(`用户 ${chatId}: ${error.message}`);
          logError('broadcastMessage', error, { chatId, isMedia });
        }
      });
      
      await Promise.allSettled(promises);
      
      if (i + CONSTANTS.BROADCAST_BATCH_SIZE < validUserIds.length) {
        await new Promise(resolve => setTimeout(resolve, CONSTANTS.BROADCAST_DELAY_MS));
      }
    }
    
    logInfo('broadcastMessage', 'Broadcast completed', { 
      success: results.success, 
      failed: results.failed, 
      errorCount: results.errors.length 
    });
    
    return results;
  } catch (error) {
    logError('broadcastMessage', error, { userIds, message, isMedia });
    return { success: 0, failed: 1, errors: [error.message] };
  }
}

// 统一的Telegram API调用函数
async function callTelegramAPI(method, params, botToken) {
  const url = `${CONSTANTS.TELEGRAM_API_BASE}${botToken}/${method}`;
  
  try {
    validateInput(method, 'text', { maxLength: 100 });
    
    const response = await withRetry(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), CONSTANTS.API_TIMEOUT_MS);
      
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(params),
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        return response;
      } catch (error) {
        clearTimeout(timeoutId);
        throw error;
      }
    }, `callTelegramAPI-${method}`);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Telegram API error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const result = await response.json();
    
    if (typeof result !== 'object' || !result.hasOwnProperty('ok')) {
      throw new Error('Invalid API response format');
    }
    
    return result;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Telegram API timeout for ${method}`);
    }
    logError('callTelegramAPI', error, { method, params: Object.keys(params) });
    throw error;
  }
}

// 转义 Telegram Markdown 特殊字符
function escapeMarkdown(text) {
  if (typeof text !== 'string') {
    return text;
  }
  return text.replace(/[_*\[\]`]/g, '\\$&');
}

// 发送消息
async function sendMessage(chatId, text, botToken, options = {}) {
  try {
    validateInput(chatId, 'chatId');
    validateInput(text, 'text', { maxLength: 4096 });
    
    const params = {
      chat_id: chatId,
      text: text,
      parse_mode: options.parse_mode || 'Markdown',
      disable_web_page_preview: options.disable_web_page_preview !== undefined ? options.disable_web_page_preview : true,
      ...options
    };
    
    return await callTelegramAPI('sendMessage', params, botToken);
  } catch (error) {
    logError('sendMessage', error, { chatId, textLength: text?.length });
    throw error;
  }
}

// 复制消息
async function copyMessage(chatId, fromChatId, messageId, botToken, options = {}) {
  try {
    validateInput(chatId, 'chatId');
    validateInput(fromChatId, 'chatId');
    
    if (!messageId || typeof messageId !== 'number') {
      throw new Error('Invalid message ID');
    }
    
    const params = {
      chat_id: chatId,
      from_chat_id: fromChatId,
      message_id: messageId,
      parse_mode: options.parse_mode || 'Markdown',
      disable_web_page_preview: options.disable_web_page_preview !== undefined ? options.disable_web_page_preview : true,
      ...options
    };
    
    return await callTelegramAPI('copyMessage', params, botToken);
  } catch (error) {
    logError('copyMessage', error, { chatId, fromChatId, messageId });
    throw error;
  }
}

// 设置Webhook
async function setWebhook(url, botToken, secret = '') {
  const params = {
    url: url,
    secret_token: secret
  }
  return await callTelegramAPI('setWebhook', params, botToken)
}

// 获取机器人信息
async function getMe(botToken) {
  return await callTelegramAPI('getMe', {}, botToken)
}

// 编辑消息文本
async function editMessageText(chatId, messageId, text, botToken, options = {}) {
  try {
    validateInput(chatId, 'chatId');
    validateInput(text, 'text', { maxLength: 4096 });
    
    const params = {
      chat_id: chatId,
      message_id: messageId,
      text: text,
      parse_mode: options.parse_mode || 'Markdown',
      disable_web_page_preview: options.disable_web_page_preview !== undefined ? options.disable_web_page_preview : true,
      reply_markup: options.reply_markup || undefined
    };
    
    return await callTelegramAPI('editMessageText', params, botToken);
  } catch (error) {
    logError('editMessageText', error, { chatId, messageId, textLength: text?.length });
    throw error;
  }
}

// 回答回调查询（用于内联按钮加载状态）
async function answerCallbackQuery(callbackQueryId, botToken, text = '', showAlert = false) {
  try {
    const params = {
      callback_query_id: callbackQueryId,
      text,
      show_alert: !!showAlert
    };
    return await callTelegramAPI('answerCallbackQuery', params, botToken);
  } catch (error) {
    logError('answerCallbackQuery', error, { callbackQueryId });
    return { ok: false, description: error.message };
  }
}

// 生成 /users 分页文本与内联键盘
function buildUsersPage(users, page, pageSize) {
  const total = users.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const start = (currentPage - 1) * pageSize;
  const end = Math.min(start + pageSize, total);
  
  const list = users.slice(start, end).map((user, idx) => {
    const lastActive = new Date(user.lastActive).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const escapedName = escapeMarkdown(user.userName || 'Unknown');
    const displayIndex = start + idx + 1;
    const verifiedStatus = user.verified ? '✅' : '⏳';
    return `${displayIndex}. ${verifiedStatus} ${escapedName}\n   ID: \`${user.chatId}\`\n   最后活跃: ${lastActive}`;
  }).join('\n\n');
  
  const header = `👥 *用户列表*  (第 ${currentPage}/${totalPages} 页 · 共 ${total} 人)`;
  const body = list || '_暂无数据_';
  const text = `${header}\n\n${body}`;
  
  const pageSizes = CONSTANTS.USERS_PAGE_SIZES || [10, 20, 50];
  const sizeRow = pageSizes.map((size) => ({
    text: size === pageSize ? `·${size}` : `${size}`,
    callback_data: `users:p=${currentPage},s=${size}`
  }));

  const inline_keyboard = [];
  const navRow = [];
  if (currentPage > 1) {
    navRow.push({ text: '◀️ 上一页', callback_data: `users:p=${currentPage - 1},s=${pageSize}` });
  }
  if (currentPage < totalPages) {
    navRow.push({ text: '下一页 ▶️', callback_data: `users:p=${currentPage + 1},s=${pageSize}` });
  }
  if (navRow.length > 0) inline_keyboard.push(navRow);
  inline_keyboard.push(sizeRow);
  
  return { text, reply_markup: { inline_keyboard }, page: currentPage, pageSize };
}

function parseUsersCallbackData(data) {
  const defaults = { page: 1, pageSize: CONSTANTS.USERS_DEFAULT_PAGE_SIZE || 20 };
  if (!data || !data.startsWith('users:')) return defaults;
  try {
    const payload = data.substring('users:'.length);
    const pairs = payload.split(',');
    const map = {};
    for (const pair of pairs) {
      const [k, v] = pair.split('=');
      if (k && v) map[k.trim()] = v.trim();
    }
    const page = parseInt(map.p || map.page || defaults.page, 10) || defaults.page;
    const pageSize = parseInt(map.s || map.pageSize || defaults.pageSize, 10) || defaults.pageSize;
    return { page, pageSize };
  } catch {
    return defaults;
  }
}

// 创建格式化的用户信息
function createUserInfo(message) {
  const { from, chat } = message
  const displayName = from.username || from.first_name || 'Unknown'
  const username = from.username || null
  const userId = from.id
  const chatId = chat.id
  const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
  
  const escapedDisplayName = escapeMarkdown(displayName)
  const escapedUsernameForHeader = username ? escapeMarkdown(`@${username}`) : ''

  return {
    userName: displayName,
    username: username,
    userId,
    chatId,
    time,
    header: `📩 *来自用户: ${escapedDisplayName}*\n🆔 ID: \`${userId}\`${username ? `\n👤 用户名: ${escapedUsernameForHeader}` : ''}\n⏰ 时间: ${time}\n────────────────────`
  }
}

// 改进的媒体消息发送函数
async function sendMediaReplyToUser(userChatId, adminChatId, messageId, originalCaption, botToken) {
  try {
    const replyPrefix = '💬 管理员回复:';
    const escapedCaption = originalCaption ? escapeMarkdown(originalCaption) : ''
    const fullCaption = escapedCaption 
      ? `${replyPrefix}\n\n${escapedCaption}` 
      : replyPrefix;
    
    const finalCaption = fullCaption.length > 1024 
      ? `${replyPrefix}\n\n${escapedCaption.substring(0, 1024 - replyPrefix.length - 4)}...`
      : fullCaption;
    
    const result = await copyMessage(userChatId, adminChatId, messageId, botToken, {
      caption: finalCaption
    });
    
    if (result.ok) {
      return result;
    }
    
    logInfo('sendMediaReplyToUser', 'Caption failed, sending separately', { 
      error: result.description,
      userChatId 
    });
    
    await sendMessage(userChatId, replyPrefix, botToken);
    
    return await copyMessage(userChatId, adminChatId, messageId, botToken);
    
  } catch (error) {
    logError('sendMediaReplyToUser', error, { userChatId, messageId });
    
    try {
      await sendMessage(userChatId, '💬 管理员发送了一个文件', botToken);
      return await copyMessage(userChatId, adminChatId, messageId, botToken);
    } catch (fallbackError) {
      logError('sendMediaReplyToUser', fallbackError, { userChatId, messageId, stage: 'fallback' });
      throw fallbackError;
    }
  }
}

// 生成验证挑战
function generateVerificationChallenge() {
    let num1 = Math.floor(Math.random() * 100);
    let num2 = Math.floor(Math.random() * 100);
    const operators = ['+', '-', '*'];
    const op = operators[Math.floor(Math.random() * operators.length)];
    let question, answer;

    switch (op) {
        case '+':
            question = `${num1} + ${num2}`;
            answer = num1 + num2;
            break;
        case '-':
            if (num1 < num2) [num1, num2] = [num2, num1];
            question = `${num1} - ${num2}`;
            answer = num1 - num2;
            break;
        case '*':
            num1 = Math.floor(Math.random() * 10) + 1;
            num2 = Math.floor(Math.random() * 10) + 1;
            question = `${num1} × ${num2}`;
            answer = num1 * num2;
            break;
    }
    return { question: `请计算: ${question} = ?`, answer: answer.toString() };
}

// 处理用户消息
async function handleUserMessage(message, env) {
  const userInfo = createUserInfo(message);

  if (env.ENABLE_USER_TRACKING !== 'true') {
    console.log("用户跟踪未启用，跳过验证，直接转发。");
    await forwardUserMessage(message, env, userInfo, null);
    return;
  }
  
  const now = Date.now();
  await addUserToKV(userInfo.chatId, userInfo, env);
  const user = await getUserFromKV(userInfo.chatId, env);

  if (user && user.verified) {
    const timeSinceLastActive = now - new Date(user.lastActive).getTime();
    
    if (timeSinceLastActive > CONSTANTS.VERIFICATION_TIMEOUT_MS) {
      logInfo('handleUserMessage', 'User verification expired', { chatId: userInfo.chatId });
      await sendMessage(userInfo.chatId, `⏰ 由于您长时间未活动，需要重新进行验证。`, env.BOT_TOKEN);
      
      user.verified = false;
      user.firstMessageSent = false;
      await updateUserInKV(user, env);
      await sendVerificationChallenge(userInfo, env);
      return;
    }
    
    user.lastActive = new Date(now).toISOString();
    await updateUserInKV(user, env);
    await forwardUserMessage(message, env, userInfo, user);
    return;
  }

  if (message.text === '/start') {
      await sendVerificationChallenge(userInfo, env);
      return;
  }
  
  if (user && user.verificationChallenge) {
    const userAnswer = message.text.trim();
    if (userAnswer === user.verificationChallenge.answer) {
        user.verified = true;
        user.firstMessageSent = false;
        user.lastActive = new Date(now).toISOString();
        delete user.verificationChallenge;
        await updateUserInKV(user, env);
        await sendMessage(userInfo.chatId, `✅ 验证成功！\n\n您的第一条消息必须是纯文本信息（不能包含链接）。之后您便可以发送任何类型的消息。`, env.BOT_TOKEN);
    } else {
        await sendMessage(userInfo.chatId, `❌ 回答错误，请重试。`, env.BOT_TOKEN);
        await sendVerificationChallenge(userInfo, env);
    }
  } else {
    await sendVerificationChallenge(userInfo, env);
  }
}

// 发送验证挑战给用户
async function sendVerificationChallenge(userInfo, env) {
    const challenge = generateVerificationChallenge();
    const user = await getUserFromKV(userInfo.chatId, env) || { chatId: userInfo.chatId };
    user.verificationChallenge = { answer: challenge.answer };
    await updateUserInKV(user, env);

    await sendMessage(
        userInfo.chatId,
        `👋 你好！在开始聊天前，请先完成一个简单的验证以证明你不是机器人。\n\n${challenge.question}`,
        env.BOT_TOKEN
    );
}

// --- ADDED ---
// Helper function to detect links in text
function containsLink(text) {
  if (typeof text !== 'string') return false;
  // This regex is designed to be broad, catching http, https, www, and domain.tld formats.
  const urlRegex = /(?:(?:https?|ftp):\/\/)?(?:www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&//=]*)/i;
  return urlRegex.test(text);
}

// --- MODIFIED ---
// 原始的消息转发逻辑，被封装成一个新函数
async function forwardUserMessage(message, env, userInfo, user) {
  try {
    if (message.text === '/start') {
      await sendMessage(
        userInfo.chatId, 
        `👋 你好！我是消息转发机器人。\n\n请发送你的消息，我会转发给管理员并尽快回复你。`, 
        env.BOT_TOKEN
      );
      return;
    }
    
    // Check for first message: must be text and contain no links
    if (user && user.firstMessageSent === false) {
      const hasLink = containsLink(message.text);
      if (!message.text || hasLink) {
        const reason = hasLink ? "包含链接" : "不是文本信息";
        await sendMessage(userInfo.chatId, `💬 您的第一条消息必须是纯文本，不能${reason}。请重新发送。`, env.BOT_TOKEN);
        return; // Do not forward
      }
    }

    const secureUserTag = await createSecureUserTag(userInfo.chatId, env.USER_ID_SECRET, userInfo.username);
    let forwardResult;
    
    let messageOptions = {};
    if (env.ENABLE_FORUM_MODE === 'true') {
      const isForumChat = await isForum(env.ADMIN_CHAT_ID, env.BOT_TOKEN);
      if (isForumChat) {
        const topicId = await getOrCreateUserTopic(userInfo.userId, userInfo.userName, env);
        if (topicId) {
          messageOptions.message_thread_id = topicId;
        }
      }
    }
    
    if (message.text) {
      const escapedUserText = escapeMarkdown(message.text);
      const forwardText = env.ENABLE_FORUM_MODE === 'true' && messageOptions.message_thread_id
        ? `📝 *新消息:*\n${escapedUserText}\n\n📍 *来源:* ${secureUserTag}`
        : `${userInfo.header}\n📝 *消息内容:*\n${escapedUserText}\n\n📍 *来源:* ${secureUserTag}`;
      
      forwardResult = await sendMessage(env.ADMIN_CHAT_ID, forwardText, env.BOT_TOKEN, messageOptions);
    } else {
      const escapedCaption = message.caption ? escapeMarkdown(message.caption) : '';
      
      let mediaType = '📷 图片/文件';
      if (message.photo) mediaType = '📷 图片';
      else if (message.video) mediaType = '🎬 视频';
      else if (message.document) mediaType = '📄 文档';
      else if (message.voice) mediaType = '🎵 语音';
      else if (message.audio) mediaType = '🎵 音频';
      else if (message.video_note) mediaType = '🎥 视频消息';
      else if (message.sticker) mediaType = '🎭 贴纸';
      else if (message.animation) mediaType = '🎬 动画';
      
      const caption = env.ENABLE_FORUM_MODE === 'true' && messageOptions.message_thread_id
        ? `📝 *新消息:*${escapedCaption ? `\n${escapedCaption}` : `\n${mediaType}`}\n\n📍 *来源:* ${secureUserTag}`
        : `${userInfo.header}\n${escapedCaption ? `📝 *说明:* ${escapedCaption}\n\n` : ''}📍 *来源:* ${secureUserTag}`;
      
      forwardResult = await copyMessage(env.ADMIN_CHAT_ID, userInfo.chatId, message.message_id, env.BOT_TOKEN, {
        ...messageOptions,
        caption
      });
    }

    if (forwardResult.ok) {
      console.log(`消息转发成功: 用户 ${userInfo.userName} -> 管理员${messageOptions.message_thread_id ? ' (话题 ' + messageOptions.message_thread_id + ')' : ''}`);
      await sendMessage(userInfo.chatId, `✅ 你的消息已发送给管理员，请耐心等待回复。`, env.BOT_TOKEN);

      if (user && user.firstMessageSent === false) {
        user.firstMessageSent = true;
        await updateUserInKV(user, env);
      }
    }
  } catch (error) {
    console.error('处理用户消息错误:', error);
    try {
      await sendMessage(userInfo.chatId, `❌ 抱歉，消息发送失败，请稍后再试。`, env.BOT_TOKEN);
    } catch (sendError) {
      console.error('发送错误消息失败:', sendError);
    }
  }
}

// 处理管理员消息
async function handleAdminMessage(message, env) {
  try {
    if (message.text === '/start') {
      const userTrackingStatus = env.ENABLE_USER_TRACKING === 'true' ? '🟢 已启用' : '🔴 未启用'
      const forumModeStatus = env.ENABLE_FORUM_MODE === 'true' ? '🟢 已启用' : '🔴 未启用'
      const isForumChat = env.ENABLE_FORUM_MODE === 'true' ? await isForum(env.ADMIN_CHAT_ID, env.BOT_TOKEN) : false
      
      await sendMessage(env.ADMIN_CHAT_ID, 
        `🔧 *管理员面板*\n\n👋 欢迎使用消息转发机器人管理面板！\n\n📋 *可用命令:*\n• \`/status\` - 查看机器人状态\n• \`/help\` - 显示帮助信息\n• \`/post\` - 群发消息功能\n• \`/users\` - 查看用户列表（需启用用户跟踪）\n\n💡 *使用说明:*\n• 直接回复用户消息即可回复给对应用户\n• 使用 /post 命令进行消息群发\n• 论坛模式下，每个用户有独立话题\n\n📊 *系统状态:*\n• 用户跟踪: ${userTrackingStatus}\n• 论坛模式: ${forumModeStatus}${isForumChat ? ' ✅ 已检测到论坛群组' : ''}\n\n🤖 机器人已就绪，等待用户消息...`, 
        env.BOT_TOKEN, 
        { message_thread_id: message.message_thread_id }
      )
      return
    }

    if (message.text === '/status') {
      const users = await getUsersFromKV(env);
      const userCount = env.ENABLE_USER_TRACKING === 'true' 
        ? `${users.length} (已验证: ${users.filter(u=>u.verified).length})`
        : '未启用跟踪'
      
      const forumModeStatus = env.ENABLE_FORUM_MODE === 'true' ? '🟢 已启用' : '🔴 未启用'
      const isForumChat = env.ENABLE_FORUM_MODE === 'true' ? await isForum(env.ADMIN_CHAT_ID, env.BOT_TOKEN) : false
      
      let topicCount = 0
      if (env.ENABLE_FORUM_MODE === 'true') {
        const mapping = await getUserTopicMapping(env)
        topicCount = Object.keys(mapping).length
      }
      
      await sendMessage(env.ADMIN_CHAT_ID, 
        `📊 *机器人状态*\n\n🟢 状态: 运行中\n🔄 模式: 无状态转发\n👥 已跟踪用户: ${userCount}\n🗣️ 论坛模式: ${forumModeStatus}${isForumChat ? ' (论坛群组)' : ''}\n📝 用户话题: ${topicCount}\n⏰ 查询时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`, 
        env.BOT_TOKEN, 
        { message_thread_id: message.message_thread_id }
      )
      return
    }

    if (message.text === '/help') {
      const forumHelp = env.ENABLE_FORUM_MODE === 'true' ? 
        `\n\n🗣️ *论坛模式:*\n• 每个用户有独立话题\n• 在话题中直接发送消息即可回复用户\n• 支持话题内的媒体消息回复` : ''
      
      await sendMessage(env.ADMIN_CHAT_ID, 
        `❓ *帮助信息*\n\n🔄 *回复用户:*\n直接回复用户的消息即可发送回复给对应用户\n\n📢 *群发消息:*\n• \`/post all 消息内容\` - 向所有已验证用户群发\n• \`/post 123,456,789 消息内容\` - 向指定用户群发\n• 回复媒体消息并使用 /post 命令可群发媒体\n\n👥 *用户管理:*\n• \`/users\` - 查看已跟踪的用户列表 (✅ 已验证, ⏳ 未验证)\n\n📝 *消息格式:*\n• 支持文本、图片、文件等各种消息类型\n• 支持Markdown格式${forumHelp}\n\n⚙️ *命令列表:*\n• \`/start\` - 显示欢迎信息\n• \`/status\` - 查看机器人状态\n• \`/help\` - 显示此帮助信息\n• \`/post\` - 群发消息功能\n• \`/users\` - 查看用户列表`, 
        env.BOT_TOKEN, 
        { message_thread_id: message.message_thread_id }
      )
      return
    }

    if (message.text && message.text.startsWith('/post')) {
      const commandText = message.text.substring(5).trim()
      
      if (!commandText) {
        await sendMessage(env.ADMIN_CHAT_ID, 
          `📢 *群发功能使用说明*\n\n🎯 *命令格式:*\n• \`/post all 消息内容\` - 向所有已验证用户群发\n• \`/post 123,456,789 消息内容\` - 向指定用户群发\n\n💡 *示例:*\n• \`/post all 系统维护通知：今晚22:00-23:00进行维护\`\n• \`/post 123456789,987654321 您好，这是一条测试消息\`\n\n📎 *群发媒体:*\n回复包含图片/文件的消息，然后使用 /post 命令\n\n⚠️ *注意:*\n• 使用 'all' 需要启用用户跟踪功能\n• 手动指定用户ID时，请用英文逗号分隔\n• 群发会自动限速以避免API限制`, 
          env.BOT_TOKEN, 
          { 
            reply_to_message_id: message.message_id,
            message_thread_id: message.message_thread_id
          }
        )
        return
      }

      const { userIds, message: postMessage } = parsePostTargets(commandText)
      
      if (!postMessage) {
        await sendMessage(env.ADMIN_CHAT_ID, 
          `❌ 请提供要群发的消息内容`, 
          env.BOT_TOKEN, 
          { 
            reply_to_message_id: message.message_id,
            message_thread_id: message.message_thread_id
          }
        )
        return
      }

      if (userIds === 'all' && env.ENABLE_USER_TRACKING !== 'true') {
        await sendMessage(env.ADMIN_CHAT_ID, 
          `❌ 使用 'all' 群发需要启用用户跟踪功能\n\n请设置环境变量 \`ENABLE_USER_TRACKING=true\` 并绑定KV存储`, 
          env.BOT_TOKEN, 
          { 
            reply_to_message_id: message.message_id,
            message_thread_id: message.message_thread_id
          }
        )
        return
      }

      if (Array.isArray(userIds) && userIds.length === 0) {
        await sendMessage(env.ADMIN_CHAT_ID, 
          `❌ 未找到有效的用户ID\n\n请检查格式: \`/post 123,456,789 消息内容\``, 
          env.BOT_TOKEN, 
          { 
            reply_to_message_id: message.message_id,
            message_thread_id: message.message_thread_id
          }
        )
        return
      }

      const users = await getUsersFromKV(env);
      const targetCount = userIds === 'all' ? users.filter(u=>u.verified).length : userIds.length;
      await sendMessage(env.ADMIN_CHAT_ID, 
        `🚀 开始群发消息...\n\n📊 目标用户数: ${targetCount}\n⏳ 请稍候...`, 
        env.BOT_TOKEN, 
        { 
          reply_to_message_id: message.message_id,
          message_thread_id: message.message_thread_id
        }
      )

      const results = await broadcastMessage(userIds, postMessage, env)
      
      const reportText = `📊 *群发完成报告*\n\n✅ 成功: ${results.success}\n❌ 失败: ${results.failed}\n\n${results.errors.length > 0 ? `🔍 *错误详情:*\n${results.errors.slice(0, CONSTANTS.MAX_ERROR_DISPLAY).join('\n')}${results.errors.length > CONSTANTS.MAX_ERROR_DISPLAY ? `\n... 还有 ${results.errors.length - CONSTANTS.MAX_ERROR_DISPLAY} 个错误` : ''}` : '🎉 全部发送成功！'}`
      
      await sendMessage(env.ADMIN_CHAT_ID, reportText, env.BOT_TOKEN, { 
        message_thread_id: message.message_thread_id 
      })
      return
    }

    if (message.text === '/users') {
      if (env.ENABLE_USER_TRACKING !== 'true') {
        await sendMessage(env.ADMIN_CHAT_ID, 
          `❌ 用户跟踪功能未启用\n\n请设置环境变量 \`ENABLE_USER_TRACKING=true\` 并绑定KV存储`, 
          env.BOT_TOKEN, 
          { message_thread_id: message.message_thread_id }
        )
        return
      }

      const users = await getUsersFromKV(env)
      if (users.length === 0) {
        await sendMessage(env.ADMIN_CHAT_ID, 
          `📭 暂无用户记录\n\n用户首次发送消息后会自动记录`, 
          env.BOT_TOKEN, 
          { message_thread_id: message.message_thread_id }
        )
        return
      }

      users.sort((a, b) => new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime())
      const pageSize = CONSTANTS.USERS_DEFAULT_PAGE_SIZE || 20
      const { text, reply_markup } = buildUsersPage(users, 1, pageSize)
      await sendMessage(env.ADMIN_CHAT_ID, text, env.BOT_TOKEN, { 
        message_thread_id: message.message_thread_id,
        reply_markup
      })
      return
    }

    if (message.reply_to_message) {
      const repliedMessage = message.reply_to_message
      
      const hasUserTag = repliedMessage.text?.includes('[USER:') || repliedMessage.caption?.includes('[USER:')
      if (message.text && message.text.startsWith('/post') && !hasUserTag) {
        const commandText = message.text.substring(5).trim()
        const { userIds, message: postMessage } = parsePostTargets(commandText)
        
        if (!postMessage) {
          await sendMessage(env.ADMIN_CHAT_ID, 
            `❌ 请提供要群发的消息内容`, 
            env.BOT_TOKEN, 
            { 
              reply_to_message_id: message.message_id,
              message_thread_id: message.message_thread_id
            }
          )
          return
        }

        const users = await getUsersFromKV(env);
        const targetCount = userIds === 'all' ? users.filter(u=>u.verified).length : userIds.length;
        await sendMessage(env.ADMIN_CHAT_ID, 
          `🚀 开始群发媒体消息...\n\n📊 目标用户数: ${targetCount}`, 
          env.BOT_TOKEN, 
          { 
            reply_to_message_id: message.message_id,
            message_thread_id: message.message_thread_id
          }
        )

        const results = await broadcastMessage(userIds, postMessage, env, true, { 
          messageId: repliedMessage.message_id 
        })
        
        const reportText = `📊 *媒体群发完成*\n\n✅ 成功: ${results.success}\n❌ 失败: ${results.failed}`
        await sendMessage(env.ADMIN_CHAT_ID, reportText, env.BOT_TOKEN, { 
          message_thread_id: message.message_thread_id 
        })
        return
      }
      
      let userChatId = await extractUserChatId(repliedMessage.text || repliedMessage.caption, env.USER_ID_SECRET)

      if (!userChatId && env.ENABLE_FORUM_MODE === 'true' && message.message_thread_id) {
        userChatId = await getUserIdFromTopicId(message.message_thread_id, env)
        console.log(`从话题ID ${message.message_thread_id} 找到用户: ${userChatId}`)
      }

      if (!userChatId) {
        const helpText = env.ENABLE_FORUM_MODE === 'true' 
          ? `⚠️ 无法识别用户信息。请确保:\n• 回复带有用户标识的转发消息\n• 或在对应用户的话题中直接回复`
          : `⚠️ 无法识别用户信息。请回复带有用户标识的转发消息。`
        
        await sendMessage(env.ADMIN_CHAT_ID, helpText, env.BOT_TOKEN, { 
          reply_to_message_id: message.message_id,
          message_thread_id: message.message_thread_id
        })
        return
      }

      let replyResult
      if (message.text) {
        const escapedText = escapeMarkdown(message.text);
        replyResult = await sendMessage(userChatId, `💬 *管理员回复:*\n\n${escapedText}`, env.BOT_TOKEN)
      } else {
        replyResult = await sendMediaReplyToUser(userChatId, env.ADMIN_CHAT_ID, message.message_id, message.caption, env.BOT_TOKEN)
      }

      if (replyResult.ok) {
        await sendMessage(env.ADMIN_CHAT_ID, 
          `✅ 回复已发送给用户 (ID: ${userChatId})`, 
          env.BOT_TOKEN, 
          { 
            reply_to_message_id: message.message_id,
            message_thread_id: message.message_thread_id
          }
        )
        console.log(`回复发送成功: 管理员 -> 用户 ${userChatId}`)
      } else {
        await sendMessage(env.ADMIN_CHAT_ID, 
          `❌ 回复发送失败: ${replyResult.description || '未知错误'}`, 
          env.BOT_TOKEN, 
          { 
            reply_to_message_id: message.message_id,
            message_thread_id: message.message_thread_id
          }
        )
      }
    } else if (env.ENABLE_FORUM_MODE === 'true' && message.message_thread_id) {
      const isSystemMessage = message.forum_topic_created || 
                             message.forum_topic_edited || 
                             message.forum_topic_closed || 
                             message.forum_topic_reopened ||
                             !message.text && !message.photo && !message.document && !message.video && !message.audio && !message.voice && !message.sticker
      
      if (isSystemMessage) {
        console.log(`忽略系统消息: 话题 ${message.message_thread_id}`)
        return
      }
      
      const userChatId = await getUserIdFromTopicId(message.message_thread_id, env)
      
      if (userChatId) {
        let replyResult
        if (message.text) {
          const escapedText = escapeMarkdown(message.text);
          replyResult = await sendMessage(userChatId, `💬 *管理员回复:*\n\n${escapedText}`, env.BOT_TOKEN)
        } else {
          replyResult = await sendMediaReplyToUser(userChatId, env.ADMIN_CHAT_ID, message.message_id, message.caption, env.BOT_TOKEN)
        }

        if (replyResult.ok) {
          await sendMessage(env.ADMIN_CHAT_ID, 
            `✅ 消息已发送给用户 (ID: ${userChatId})`, 
            env.BOT_TOKEN, 
            { 
              reply_to_message_id: message.message_id,
              message_thread_id: message.message_thread_id
            }
          )
          console.log(`消息发送成功: 管理员 -> 用户 ${userChatId}`)
        } else {
          await sendMessage(env.ADMIN_CHAT_ID, 
            `❌ 消息发送失败: ${replyResult.description || '未知错误'}`, 
            env.BOT_TOKEN, 
            { 
              reply_to_message_id: message.message_id,
              message_thread_id: message.message_thread_id
            }
          )
        }
      } else {
        await sendMessage(env.ADMIN_CHAT_ID, 
          `⚠️ 无法识别此话题对应的用户。请确保话题是由用户消息自动创建的。`, 
          env.BOT_TOKEN, 
          { 
            reply_to_message_id: message.message_id,
            message_thread_id: message.message_thread_id
          }
        )
      }
    } else {
      await sendMessage(env.ADMIN_CHAT_ID, 
        `💡 *提示:* 请回复具体的用户消息来发送回复，或使用群发命令。\n\n📢 群发: \`/post all 消息内容\`\n❓ 帮助: \`/help\``, 
        env.BOT_TOKEN, 
        { 
          reply_to_message_id: message.message_id,
          message_thread_id: message.message_thread_id
        }
      )
    }
  } catch (error) {
    console.error('处理管理员消息错误:', error)
    try {
      const escapedErrorMessage = escapeMarkdown(error.message);
      await sendMessage(env.ADMIN_CHAT_ID, `❌ 处理消息时发生错误: ${escapedErrorMessage}`, env.BOT_TOKEN, { 
        message_thread_id: message.message_thread_id 
      })
    } catch (sendError) {
      console.error('发送错误消息失败:', sendError)
    }
  }
}

// 处理消息
async function handleMessage(message, env) {
  if (!message || !message.from || !message.chat) {
    console.error('无效的消息格式')
    return
  }

  const chatId = message.chat.id
  const userId = message.from.id
  const userName = message.from.username || message.from.first_name || 'Unknown'
  const isAdmin = chatId.toString() === env.ADMIN_CHAT_ID.toString()

  console.log(`收到消息: 来自 ${userName} (${userId}) 在聊天 ${chatId}`)

  if (isAdmin) {
    await handleAdminMessage(message, env)
  } else {
    await handleUserMessage(message, env)
  }
}

// 处理 /users 的分页回调
async function handleUsersCallbackQuery(callbackQuery, env) {
  try {
    const message = callbackQuery.message;
    const fromChatId = message?.chat?.id;
    const messageId = message?.message_id;
    if (!fromChatId || !messageId) {
      await answerCallbackQuery(callbackQuery.id, env.BOT_TOKEN, '无法定位消息');
      return;
    }

    const { page, pageSize } = parseUsersCallbackData(callbackQuery.data);
    const users = await getUsersFromKV(env);
    users.sort((a, b) => new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime());
    const { text, reply_markup } = buildUsersPage(users, page, pageSize);

    await editMessageText(fromChatId, messageId, text, env.BOT_TOKEN, { reply_markup });
    await answerCallbackQuery(callbackQuery.id, env.BOT_TOKEN);
  } catch (error) {
    logError('handleUsersCallbackQuery', error);
    await answerCallbackQuery(callbackQuery.id, env.BOT_TOKEN, '更新失败', true);
  }
}

// 处理Webhook消息
async function handleWebhook(request, env, ctx) {
  try {
    if (env.WEBHOOK_SECRET) {
      const secretToken = request.headers.get('X-Telegram-Bot-Api-Secret-Token')
      if (secretToken !== env.WEBHOOK_SECRET) {
        return new Response('Unauthorized', { status: 401 })
      }
    }

    const update = await request.json()
    
    if (update.message) {
      ctx.waitUntil(handleMessage(update.message, env))
    } else if (update.callback_query) {
      const cq = update.callback_query;
      const data = cq.data || '';
      if (data && data.startsWith('users:')) {
        ctx.waitUntil(handleUsersCallbackQuery(cq, env));
      }
    }

    return new Response('OK', { status: 200 })
  } catch (error) {
    console.error('Webhook处理错误:', error)
    
    ctx.waitUntil(
      (async () => {
        try {
          const escapedErrorMessage = escapeMarkdown(error.message);
          await sendMessage(env.ADMIN_CHAT_ID, `🚨 Bot错误: ${escapedErrorMessage}`, env.BOT_TOKEN);
        } catch (err) {
          console.error('发送错误通知失败:', err);
        }
      })()
    )
    
    return new Response('Internal Server Error', { status: 500 })
  }
}

// 处理HTTP请求
async function handleRequest(request, env, ctx) {
  try {
    validateEnvironment(env);
  } catch (error) {
    logError('handleRequest', error);
    return new Response(`Configuration error: ${error.message}`, { status: 500 });
  }

  const url = new URL(request.url)

  try {
    switch (true) {
      case request.method === 'POST' && url.pathname === '/webhook':
        return await handleWebhook(request, env, ctx)
        
      case request.method === 'GET' && url.pathname === '/setWebhook':
        const webhookUrl = `${url.origin}/webhook`
        const result = await setWebhook(webhookUrl, env.BOT_TOKEN, env.WEBHOOK_SECRET || '')
        return new Response(JSON.stringify(result, null, 2), {
          headers: { 'Content-Type': 'application/json' }
        })
        
      case request.method === 'GET' && url.pathname === '/me':
        const botInfo = await getMe(env.BOT_TOKEN)
        return new Response(JSON.stringify(botInfo, null, 2), {
          headers: { 'Content-Type': 'application/json' }
        })
        
      case request.method === 'GET' && url.pathname === '/':
        return new Response('Telegram Bot is running!', { status: 200 })
        
      default:
        return new Response('Not Found', { status: 404 })
    }
  } catch (error) {
    console.error('请求处理错误:', error)
    
    ctx.waitUntil(
      (async () => {
        try {
          const escapedErrorMessage = escapeMarkdown(error.message);
          await sendMessage(env.ADMIN_CHAT_ID, `🚨 系统错误: ${escapedErrorMessage}`, env.BOT_TOKEN);
        } catch (err) {
          console.error('发送系统错误通知失败:', err);
        }
      })()
    )
    
    return new Response('Internal Server Error', { status: 500 })
  }
}

// 导出处理函数（Cloudflare Workers需要）
export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx)
  }
}
