import express from "express";
import cors from "cors";
import crypto from "crypto";
import { MercadoPagoConfig, Preference, Payment } from "mercadopago";
import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

/* ============================================================
 * Variables de entorno (en Render -> Environment)
 * ------------------------------------------------------------
 * MP_ACCESS_TOKEN=...
 * GMAIL_USER=puntonorte.mkt@gmail.com
 * GMAIL_PASS=...                 (contraseña de APLICACIÓN)
 * BACKEND_URL=https://tu-backend.onrender.com
 * FRONTEND_URL=https://tu-app.vercel.app
 * MP_WEBHOOK_SECRET=...          (opcional)
 * ============================================================ */

const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const BACKEND_URL = process.env.BACKEND_URL;

// El frontend manda la URL completa del PDF (campo urlPDF de Firestore).

// ------------------------------------------------------------
// Mercado Pago y Gmail
// ------------------------------------------------------------
const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });

const transporte = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASS,
    },
});

transporte.verify((error) => {
    if (error) {
        console.error("❌ Error en la configuración de Nodemailer/Gmail:", error);
    } else {
        console.log("✅ El servidor de correo está listo para enviar mensajes");
    }
});

// ------------------------------------------------------------
// Express
// ------------------------------------------------------------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cors());

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
const emailValido = (e) => typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

// Solo URLs https de raw.githubusercontent.com que terminen en .pdf
const urlPdfValida = (s) => {
    if (typeof s !== "string" || s.length > 500) return false;
    try {
        const u = new URL(s);
        return (
            u.protocol === "https:" &&
            u.hostname === "raw.githubusercontent.com" &&
            /\.pdf$/i.test(u.pathname)
        );
    } catch {
        return false;
    }
};

const nombreArchivoSeguro = (s) =>
    String(s).replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 100) || "resumen";

async function obtenerPdfBuffer(pdfUrl) {
    const response = await fetch(pdfUrl);
    if (!response.ok) {
        throw new Error(`No se pudo descargar el PDF (${response.status}) desde ${pdfUrl}`);
    }
    return Buffer.from(await response.arrayBuffer());
}

// Busca el email del comprador en todos los lugares donde MP puede traerlo
function obtenerEmailComprador(pago) {
    const candidatos = [
        pago.payer?.email,
        pago.additional_info?.payer?.email,
        pago.metadata?.email,
    ];
    return candidatos.find(emailValido)?.trim() || null;
}

// Idempotencia en memoria (se pierde si Render reinicia el servicio)
const pagosProcesados = new Set();
const pagosEnProceso = new Set();

// Validación de firma del webhook (solo si definís MP_WEBHOOK_SECRET)
function firmaValida(req) {
    const secret = process.env.MP_WEBHOOK_SECRET;
    if (!secret) return true;

    const xSignature = req.get("x-signature");
    const xRequestId = req.get("x-request-id");
    if (!xSignature) return false;

    let ts, v1;
    for (const part of xSignature.split(",")) {
        const [k, v] = part.split("=").map((s) => s.trim());
        if (k === "ts") ts = v;
        if (k === "v1") v1 = v;
    }
    if (!ts || !v1) return false;

    const dataId = String(req.query["data.id"] ?? req.body?.data?.id ?? "").toLowerCase();

    let manifest = "";
    if (dataId) manifest += `id:${dataId};`;
    if (xRequestId) manifest += `request-id:${xRequestId};`;
    manifest += `ts:${ts};`;

    const esperado = crypto.createHmac("sha256", secret).update(manifest).digest("hex");
    try {
        return crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(v1));
    } catch {
        return false;
    }
}

// ------------------------------------------------------------
// POST /create_preference
// Recibe lo que manda tu frontend: { title, price, id }
// ------------------------------------------------------------
app.post("/create_preference", async (req, res) => {
    try {
        const { title, price, id, pdfUrl } = req.body;

        if (!title || !(Number(price) > 0) || !/^\d+$/.test(String(id)) || !urlPdfValida(pdfUrl)) {
            console.error("❌ create_preference: datos inválidos", req.body);
            return res.status(400).json({ error: "Datos del producto inválidos" });
        }

        const body = {
            items: [
                {
                    id: String(id),
                    title: String(title),
                    unit_price: Number(price),
                    quantity: 1,
                    currency_id: "ARS",
                },
            ],
            external_reference: `${id}-${Date.now()}`,
            // Lo guardamos para recuperarlo en el webhook
            metadata: {
                product_id: String(id),
                title: String(title),
                pdf_url: String(pdfUrl),
            },
            back_urls: {
                success: `${FRONTEND_URL}/`,
                failure: `${FRONTEND_URL}/`,
                pending: `${FRONTEND_URL}/`,
            },
        };

        if (BACKEND_URL) {
            body.notification_url = `${BACKEND_URL}/webhook`;
        }

        const result = await new Preference(client).create({ body });
        res.json({ init_point: result.init_point });
    } catch (err) {
        console.error("DETALLE DEL ERROR DE MP:", JSON.stringify(err, null, 2));
        res.status(500).json({
            error: "Error al crear la preferencia de pago",
            details: err.message,
        });
    }
});

// ------------------------------------------------------------
// POST /webhook
// ------------------------------------------------------------
app.post("/webhook", async (req, res) => {
    console.log("🔔 Webhook recibido:", JSON.stringify(req.body));

    if (!firmaValida(req)) {
        console.error("❌ Firma de webhook inválida");
        return res.sendStatus(401);
    }

    // Respondemos 200 ya para que MP no reintente mientras procesamos
    res.status(200).send("Webhook recibido");

    try {
        const paymentId = req.body?.data?.id || req.query["data.id"] || req.body?.id;
        const topic = req.body?.type || req.body?.topic || req.query?.type;

        if (!paymentId || topic !== "payment") return;

        const key = String(paymentId);
        if (pagosProcesados.has(key) || pagosEnProceso.has(key)) {
            console.log(`↩️ Pago ${key} ya procesado o en proceso, se ignora`);
            return;
        }
        pagosEnProceso.add(key);

        try {
            const pago = await new Payment(client).get({ id: key });
            console.log(`🔍 Estado del pago ${key}:`, pago.status);

            if (pago.status !== "approved") return;

            // Para diagnosticar: qué datos del comprador mandó MP
            console.log("👤 Datos del pagador:", JSON.stringify({
                payer: pago.payer,
                additional_info_payer: pago.additional_info?.payer,
                metadata: pago.metadata,
            }));

            const productId = pago.metadata?.product_id ?? pago.additional_info?.items?.[0]?.id;
            const titulo = pago.metadata?.title ?? pago.additional_info?.items?.[0]?.title ?? "Resumen";

            const pdfUrl = pago.metadata?.pdf_url;
            if (!urlPdfValida(pdfUrl)) {
                console.error(`❌ Pago ${key}: pdf_url inválida o ausente en metadata (producto ${productId})`, pdfUrl);
                return;
            }
            const emailComprador = obtenerEmailComprador(pago);

            console.log(`📥 Descargando PDF desde: ${pdfUrl}`);
            const pdfBuffer = await obtenerPdfBuffer(pdfUrl);
            const adjunto = [{ filename: `${nombreArchivoSeguro(titulo)}.pdf`, content: pdfBuffer }];

            if (emailComprador) {
                console.log(`📧 Enviando "${titulo}" a ${emailComprador}`);
                await transporte.sendMail({
                    from: `"Punto Norte" <${process.env.GMAIL_USER}>`,
                    to: emailComprador,
                    subject: `¡Tu resumen de ${titulo} ya está aquí! 🎓`,
                    text: `¡Hola! Gracias por tu compra. Adjunto a este correo encontrarás tu resumen de ${titulo} en formato PDF.`,
                    attachments: adjunto,
                });
                console.log(`✅ Correo enviado con éxito a ${emailComprador} (pago ${key})`);
            } else {
                // Respaldo: MP no devolvió email. Te lo mandamos a vos para que lo reenvíes.
                console.error(`⚠️ Pago ${key} sin email del comprador. Se envía el PDF al dueño.`);
                await transporte.sendMail({
                    from: `"Punto Norte" <${process.env.GMAIL_USER}>`,
                    to: process.env.GMAIL_USER,
                    subject: `⚠️ Pago ${key} aprobado SIN email del comprador`,
                    text:
                        `Mercado Pago no informó el email del comprador.\n` +
                        `Producto: ${titulo}\n` +
                        `Pago: ${key}\n` +
                        `Nombre: ${pago.payer?.first_name ?? "-"} ${pago.payer?.last_name ?? ""}\n` +
                        `Documento: ${pago.payer?.identification?.number ?? "-"}\n\n` +
                        `Reenviale el PDF adjunto manualmente.`,
                    attachments: adjunto,
                });
            }

            pagosProcesados.add(key);
        } finally {
            pagosEnProceso.delete(key);
        }
    } catch (error) {
        console.error("❌ Error al procesar el webhook:", error);
    }
});

app.listen(PORT, () => {
    console.log(`El servidor corre en el puerto ${PORT}`);
});