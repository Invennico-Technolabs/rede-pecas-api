import express from 'express';
import { verifyWebhook, receiveWebhookMessage } from '../../controllers/whatsapp.controller.js';
import { verifyWhatsAppSignature } from '../../middlewares/whatsappSignature.js';

const router = express.Router();

router.get('/', verifyWebhook);
router.post('/', verifyWhatsAppSignature, receiveWebhookMessage);

export default router;
