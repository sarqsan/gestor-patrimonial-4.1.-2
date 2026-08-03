# Guía de Publicación en Render

Esta aplicación está lista para desplegarse como un **Web Service** en [Render](https://render.com/).

## Pasos para publicar en Render:

### 1. Descargar o Exportar el Código
- En la interfaz de AI Studio, exporta o descarga el proyecto a un repositorio de **GitHub** (o descarga el archivo ZIP y súbelo a un repositorio público/privado de GitHub).

### 2. Crear una cuenta e Iniciar en Render
- Accede a [render.com](https://render.com/) e inicia sesión con tu cuenta de GitHub.

### 3. Crear un nuevo Web Service
1. En el panel de Render, haz clic en **New +** y selecciona **Web Service**.
2. Conecta tu repositorio de GitHub donde subiste este proyecto.
3. Render detectará automáticamente el archivo `render.yaml` si utilizas Blueprint, o puedes configurarlo manualmente con los siguientes valores:
   - **Name**: `remix-logeado` (o el nombre que prefieras).
   - **Environment**: `Node`.
   - **Region**: La más cercana a tus usuarios (ej. Frankfurt / Frankfurt, EU).
   - **Branch**: `main` (o la rama principal).
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm run start`

### 4. Configurar Variables de Entorno (Environment Variables)
En la pestaña **Environment** de tu servicio en Render, añade las siguientes variables:
- `NODE_ENV`: `production`
- `GEMINI_API_KEY`: Tu clave de la API de Gemini (obtén una gratis en [Google AI Studio](https://aistudio.google.com/app/apikey)).

### 5. Desplegar
- Haz clic en **Create Web Service**.
- Render compilará la aplicación (`npm run build`) y ejecutará el servidor Node.js (`npm run start`).
- Una vez finalizado el proceso (el estado pasará a **Live**), obtendrás una URL pública del tipo `https://tu-app.onrender.com`.

---

## Verificación Local / Manual
Si deseas probar el build de producción en local antes de desplegar:
```bash
npm run build
npm run start
```
El servidor se iniciará y escuchará en el puerto asignado (por defecto 3000 o el puerto especificado en la variable `PORT`).
