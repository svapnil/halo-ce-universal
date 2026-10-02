/*
WEB_GL.C

The renderer's OpenGL ES helpers for WebGL 2. The browser build compiles
the renderer's OpenGL ES path (HALO_ANDROID in d3d8_gl.c and its helpers;
tools/web_build.py), which calls these where the Android port calls its host
(port/android/host/host_gl.c).
*/

#include <GLES3/gl3.h>
#include <stdint.h>
#include <string.h>

int host_gl_has_extension(const char *name)
{
	GLint count = 0, index;

	/* Emscripten names WebGL's extensions GL_<name>: S3TC is one WebGL
	extension where ES has three */
	if (!strcmp(name, "GL_EXT_texture_compression_s3tc"))
		name = "GL_WEBGL_compressed_texture_s3tc";
	glGetIntegerv(GL_NUM_EXTENSIONS, &count);
	for (index = 0; index < count; index++)
	{
		const char *extension = (const char *)glGetStringi(GL_EXTENSIONS, (GLuint)index);

		if (extension && !strcmp(extension, name))
			return 1;
	}
	return 0;
}

/* the visibility test counters are atomic counters, which WebGL 2 does not
have (d3d8_gl.c checks before it reads one) */
uint32_t host_gl_read_buffer_word(uint32_t buffer, uint32_t offset)
{
	(void)buffer;
	(void)offset;
	return 0;
}

/* WebGL copies the data of bufferSubData when it is called, so no queued
draw can see a later write to the ring of stream buffers: there is nothing
to wait for */
void host_gl_fence_frame(uint32_t slot)
{
	(void)slot;
}

void host_gl_wait_frame(uint32_t slot)
{
	(void)slot;
}

void host_gl_buffer_write(uint32_t target, uint32_t offset, uint32_t size, const void *data)
{
	glBufferSubData(target, offset, size, data);
}
