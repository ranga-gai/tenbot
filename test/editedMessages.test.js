const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractText,
  getEditedMessageDetails,
  handleEditedMessage,
  decryptMessageEdit
} = require('../index');
const messageHistory = require('../lib/messageHistory');
const { proto } = require('@whiskeysockets/baileys');
const { aesEncryptGCM, hmacSign } = require('@whiskeysockets/baileys/lib/Utils/crypto');

describe('editedMessages', () => {
  const testChatId = 'test_chat_edited@g.us';

  beforeEach(() => {
    messageHistory.clear(testChatId);
  });

  describe('extractText', () => {
    it('should extract text from standard message structures', () => {
      assert.equal(extractText({ conversation: 'standard text' }), 'standard text');
      assert.equal(extractText({ extendedTextMessage: { text: 'extended text' } }), 'extended text');
      assert.equal(extractText({ imageMessage: { caption: 'photo caption' } }), 'photo caption');
    });

    it('should extract text from protocolMessage editedMessage (MESSAGE_EDIT)', () => {
      const editMsg = {
        protocolMessage: {
          key: { id: 'msg_123', remoteJid: testChatId },
          type: 14,
          editedMessage: {
            conversation: 'this is edited text'
          }
        }
      };
      assert.equal(extractText(editMsg), 'this is edited text');
    });

    it('should extract text from nested future proof editedMessage', () => {
      const nestedEdit = {
        editedMessage: {
          message: {
            protocolMessage: {
              key: { id: 'msg_456', remoteJid: testChatId },
              type: 14,
              editedMessage: {
                extendedTextMessage: {
                  text: 'nested edited text'
                }
              }
            }
          }
        }
      };
      assert.equal(extractText(nestedEdit), 'nested edited text');
    });

    it('should return null when message has no text or is empty', () => {
      assert.equal(extractText(null), null);
      assert.equal(extractText({}), null);
    });
  });

  describe('getEditedMessageDetails', () => {
    it('should return null for normal non-edit messages', () => {
      const normal = {
        key: { id: 'normal_1', remoteJid: testChatId },
        message: { conversation: 'hello' }
      };
      assert.equal(getEditedMessageDetails(normal), null);
    });

    it('should identify protocolMessage edit and return originalKey, editedMessage, and text', () => {
      const editMsg = {
        key: { id: 'protocol_msg_id', remoteJid: testChatId },
        message: {
          protocolMessage: {
            key: { id: 'orig_msg_1', remoteJid: testChatId, participant: 'alice@s.whatsapp.net' },
            type: 14,
            editedMessage: {
              conversation: 'updated content'
            },
            timestampMs: 1600000000000
          }
        }
      };
      const details = getEditedMessageDetails(editMsg);
      assert.ok(details);
      assert.equal(details.isEdit, true);
      assert.equal(details.originalKey.id, 'orig_msg_1');
      assert.equal(details.originalKey.participant, 'alice@s.whatsapp.net');
      assert.equal(details.text, 'updated content');
      assert.equal(details.timestamp, 1600000000000);
    });

    it('should identify messages.update structure with update.message', () => {
      const updateMsg = {
        key: { id: 'orig_msg_2', remoteJid: testChatId },
        update: {
          message: {
            conversation: 'content from update event'
          }
        },
        messageTimestamp: 1600000005
      };
      const details = getEditedMessageDetails(updateMsg);
      assert.ok(details);
      assert.equal(details.isEdit, true);
      assert.equal(details.originalKey.id, 'orig_msg_2');
      assert.equal(details.text, 'content from update event');
    });

    it('should decrypt secretEncryptedMessage using stored messageSecret and extract text', () => {
      const originalMsgId = 'orig_encrypted_1';
      const origSender = '16028031085@s.whatsapp.net';
      const editor = '16028031085@s.whatsapp.net';
      const messageSecret = Buffer.alloc(32, 0x42);

      // Create mock messageStore containing the original message
      const mockStore = new Map();
      mockStore.set(`${testChatId}:${originalMsgId}`, {
        key: { id: originalMsgId, remoteJid: testChatId, participant: origSender },
        messageSecret,
        message: { conversation: 'Original plain text' }
      });

      // Construct encrypted edit payload matching WhatsApp's wire format
      const plaintextMsg = {
        protocolMessage: {
          key: { id: originalMsgId, fromMe: false, remoteJid: testChatId },
          type: 14,
          editedMessage: { conversation: 'Decrypted edited text from PI' },
          timestampMs: 1700000000000
        }
      };
      const plaintext = proto.Message.encode(proto.Message.fromObject(plaintextMsg)).finish();
      const iv = Buffer.alloc(12, 0x12);

      const sign = Buffer.concat([
        Buffer.from(originalMsgId),
        Buffer.from(origSender),
        Buffer.from(editor),
        Buffer.from('Message Edit'),
        new Uint8Array([1])
      ]);
      const key0 = hmacSign(messageSecret, new Uint8Array(32), 'sha256');
      const encKey = hmacSign(sign, key0, 'sha256');
      const encPayload = aesEncryptGCM(plaintext, encKey, iv, Buffer.alloc(0));

      const secretEncMsg = {
        key: { id: 'secret_enc_edit_id', remoteJid: testChatId, participant: editor },
        message: {
          secretEncryptedMessage: {
            targetMessageKey: { id: originalMsgId, remoteJid: testChatId, participant: origSender },
            encPayload,
            encIv: iv,
            secretEncType: 2
          }
        }
      };

      const details = getEditedMessageDetails(secretEncMsg, mockStore);
      assert.ok(details, 'Should return edited message details');
      assert.equal(details.isEdit, true);
      assert.equal(details.originalKey.id, originalMsgId);
      assert.equal(details.text, 'Decrypted edited text from PI');
    });
  });

  describe('messageHistory.recordEditedMessage', () => {
    it('should update an existing message by id in chat-history', () => {
      const now = Date.now();
      messageHistory.recordMessage(testChatId, 'Alice', 'Original message text', now - 5000, false, 'msg_edit_1');
      let history = messageHistory.getRecentMessages(testChatId);
      assert.equal(history.length, 1);
      assert.equal(history[0].text, 'Original message text');

      messageHistory.recordEditedMessage(testChatId, 'msg_edit_1', 'Alice', 'Edited message text', now, false);
      history = messageHistory.getRecentMessages(testChatId);
      assert.equal(history.length, 1);
      assert.equal(history[0].text, 'Edited message text');
      assert.equal(history[0].edited, true);
    });

    it('should fallback to updating latest recent message from sender if id not found', () => {
      const now = Date.now();
      messageHistory.recordMessage(testChatId, 'Bob', 'First message', now - 5000, false);
      let history = messageHistory.getRecentMessages(testChatId);
      assert.equal(history.length, 1);
      assert.equal(history[0].text, 'First message');

      messageHistory.recordEditedMessage(testChatId, 'unknown_id', 'Bob', 'Edited second message', now, false);
      history = messageHistory.getRecentMessages(testChatId);
      assert.equal(history.length, 1);
      assert.equal(history[0].text, 'Edited second message');
      assert.equal(history[0].edited, true);
    });
  });

  describe('handleEditedMessage execution', () => {
    it('should interpret edited message and execute commands like !ping', async () => {
      const sentReplies = [];
      const mockSock = {
        sendMessage: async (jid, content) => {
          sentReplies.push({ jid, content });
          return { key: { id: 'reply_1' } };
        }
      };

      const editMsg = {
        key: { id: 'edit_protocol_key', remoteJid: testChatId },
        pushName: 'Alice',
        message: {
          protocolMessage: {
            key: { id: 'orig_cmd_1', remoteJid: testChatId },
            type: 14,
            editedMessage: {
              conversation: '!ping'
            }
          }
        }
      };

      const details = getEditedMessageDetails(editMsg);
      await handleEditedMessage(mockSock, editMsg, details, 'Test Group');

      assert.equal(sentReplies.length, 1);
      assert.equal(sentReplies[0].content.text, 'pong 🏓');

      // Verify chat history updated
      const history = messageHistory.getRecentMessages(testChatId);
      assert.equal(history.some((m) => m.text === '!ping'), true);
    });

    it('should respond when an unaddressed message is edited to add @tenbot or mention bot JID', async () => {
      const sentReplies = [];
      const mockSock = {
        user: { id: '14084099336:3@s.whatsapp.net', lid: '115694289027280:3@lid' },
        sendMessage: async (jid, content) => {
          sentReplies.push({ jid, content });
          return { key: { id: 'reply_mention' } };
        }
      };

      // 1. Initial message was unaddressed: "good morning everyone" (bot would ignore)
      // 2. User edits the message in WhatsApp to add "@tenbot ping"
      const editMsgText = {
        key: { id: 'edit_key_trigger', remoteJid: testChatId },
        pushName: 'Alice',
        message: {
          protocolMessage: {
            key: { id: 'orig_unaddressed_1', remoteJid: testChatId },
            type: 14,
            editedMessage: {
              conversation: '@tenbot !ping'
            }
          }
        }
      };

      const detailsText = getEditedMessageDetails(editMsgText);
      await handleEditedMessage(mockSock, editMsgText, detailsText, 'Test Group');

      assert.equal(sentReplies.length, 1);
      assert.ok(/pong/i.test(sentReplies[0].content.text));

      // 3. User edits another message using WhatsApp mention (@Tenbot) with contextInfo.mentionedJid
      const editMsgMention = {
        key: { id: 'edit_key_mention', remoteJid: testChatId },
        pushName: 'Alice',
        message: {
          protocolMessage: {
            key: { id: 'orig_unaddressed_2', remoteJid: testChatId },
            type: 14,
            editedMessage: {
              extendedTextMessage: {
                text: '@Tenbot !ping',
                contextInfo: {
                  mentionedJid: ['14084099336@s.whatsapp.net']
                }
              }
            }
          }
        }
      };

      const detailsMention = getEditedMessageDetails(editMsgMention);
      await handleEditedMessage(mockSock, editMsgMention, detailsMention, 'Test Group');

      assert.equal(sentReplies.length, 2);
      assert.ok(/pong/i.test(sentReplies[1].content.text));
    });

            it("should deduplicate identical edit events to avoid running twice", async () => {
      const sentReplies = [];
      const mockSock = {
        sendMessage: async (jid, content) => {
          sentReplies.push({ jid, content });
          return { key: { id: 'reply_2' } };
        }
      };

      const editMsg = {
        key: { id: 'edit_protocol_key_2', remoteJid: testChatId },
        pushName: 'Alice',
        message: {
          protocolMessage: {
            key: { id: 'orig_cmd_2', remoteJid: testChatId },
            type: 14,
            editedMessage: {
              conversation: '!ping'
            }
          }
        }
      };

      const details = getEditedMessageDetails(editMsg);
      await handleEditedMessage(mockSock, editMsg, details, 'Test Group');
      assert.equal(sentReplies.length, 1);

      // Re-triggering the same edit immediately should be dropped by deduplication
      await handleEditedMessage(mockSock, editMsg, details, 'Test Group');
      assert.equal(sentReplies.length, 1);
    });
  });
});
