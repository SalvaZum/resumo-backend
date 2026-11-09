import express from "express";
import cors from "cors";
import { MercadoPagoConfig, Preference } from 'mercadopago';
import nodemailer from 'nodemailer';
import { Buffer } from 'buffer';
import dotenv from 'dotenv';

dotenv.config();

// Agrega credenciales
const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });

const transporte = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASS
    }
});

// Crear una nueva aplicacion en express
const app = express();

// Configuraciones
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cors());

// Función auxiliar para descargar el PDF desde GitHub y convertirlo en Buffer
async function obtenerPdfBuffer(pdfUrl) {
    const response = await fetch(pdfUrl);
    if (!response.ok) {
        throw new Error(`No se pudo descargar el PDF desde GitHub: ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
}

// End-point create preference
app.post('/create_preference', async (req, res)=>{
    try{
        // Ahora también recibimos la url del pdf desde el frontend
        const { title, price, id, pdfUrl } = req.body;

        const preference = new Preference(client);
        const result = await preference.create({
            body: {
                items: [
                {
                    title: String(title),
                    unit_price: Number(price),
                    quantity: Number(1),
                    id: Number(id),
                    currency_id: 'ARS'
                }
                ],
                // Guardamos la URL de GitHub en metadata para recuperarla en el webhook
                metadata: {
                    pdf_url: pdfUrl || "https://raw.githubusercontent.com/SalvaZum/pfds/main/U4-IntrProgrAssembler-Teorico-2026.pdf" //[cite: 2] fallback por defecto
                },
                back_urls: {
                    success: "http://localhost:5173/",
                    failure: "http://localhost:5173/",
                    pending: "http://localhost:5173/",
                }
            }
        });

        res.json({ init_point: result.init_point });
    } catch(err){
        console.error("DETALLE DEL ERROR DE MP:", JSON.stringify(err, null, 2));
        res.status(500).json({ error: "Error al crear la preferencia de pago", details: err.message });
    }
});

// End-point send-summary (Para pruebas directas si lo requieres)
app.post('/send-summary', async (req, res)=>{
    const { email, title, pdfUrl } = req.body;
    try{
        // URL por defecto de respaldo si no mandan una
        const urlFinal = pdfUrl || "https://raw.githubusercontent.com/SalvaZum/pfds/main/U4-IntrProgrAssembler-Teorico-2026.pdf"; //[cite: 2]
        
        // Descargamos el PDF de GitHub en memoria
        const pdfBuffer = await obtenerPdfBuffer(urlFinal);

        await transporte.sendMail({
            from: "puntonorte.mkt@gmail.com",
            to: email,
            subject: `¡Tu resumen de ${title} ya está disponible! 🎓`,
            text: `¡Hola! Gracias por tu compra. Adjunto a este correo encontrarás el resumen académico de ${title} en formato PDF.`,
            attachments: [
                {
                    filename: `${title}.pdf`,
                    content: pdfBuffer // Archivo dinámico desde GitHub
                }
            ]
        });

        res.json({ success: true, message: "Correo enviado con éxito" });
    } catch(err){
        console.log(err);
        res.status(500).json({ error: "Error al enviar el correo" });
    }
});

// Endpoint Webhook
// Endpoint Webhook
app.post('/webhook', async (req, res) => {
    const paymentInfo = req.body;
    console.log("🔔 Webhook recibido de Mercado Pago:", JSON.stringify(paymentInfo));

    try {
        // Mercado Pago puede enviar el ID en diferentes estructuras según la versión
        const paymentId = paymentInfo.data?.id || paymentInfo.id;
        const topic = paymentInfo.type || paymentInfo.topic;

        if (paymentId && (topic === 'payment' || paymentInfo.action === 'payment.created')) {
            const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
                headers: {
                    'Authorization': `Bearer ${client.accessToken}`
                }
            });
            const paymentData = await response.json();

            console.log(`🔍 Estado del pago ${paymentId}:`, paymentData.status);

            if (paymentData.status === 'approved') {
                const emailComprador = paymentData.payer?.email || paymentData.metadata?.email; 
                const tituloResumen = paymentData.additional_info?.items?.[0]?.title || "Resumen Universitario";
                
                // Recuperamos la URL del PDF desde la metadata
                const pdfUrl = paymentData.metadata?.pdf_url || "https://raw.githubusercontent.com/SalvaZum/pfds/main/U4-IntrProgrAssembler-Teorico-2026.pdf";

                console.log(`📥 Descargando PDF para enviar a: ${emailComprador}`);
                const pdfBuffer = await obtenerPdfBuffer(pdfUrl);

                await transporte.sendMail({
                    from: "puntonorte.mkt@gmail.com",
                    to: emailComprador,
                    subject: `¡Tu resumen de ${tituloResumen} ya está aquí! 🎓`,
                    text: '¡Hola! Gracias por tu compra. Adjunto a este correo encontrarás tu resumen en formato PDF.',
                    attachments: [
                        {
                            filename: `${tituloResumen}.pdf`,
                            content: pdfBuffer
                        }
                    ]
                });

                console.log(`✅ ¡Pago aprobado y PDF de GitHub enviado con éxito a ${emailComprador}!`);
            }
        }

        // Siempre responder 200 rápidamente a Mercado Pago para que no reintente el webhook
        res.status(200).send("Webhook recibido");
    } catch (error) {
        console.error("❌ Error al procesar el webhook:", error);
        res.status(500).send("Error interno");
    }
});

app.listen(process.env.PORT, ()=>{
    console.log("El servidor corre en el puerto 3000");
});