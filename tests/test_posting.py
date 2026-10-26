from aiohttp import web

from umabot.posting import build_embed, prepare_post

from .conftest import make_image

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100


def image_server_routes():
    return {
        "/original.png": lambda r: web.Response(body=PNG * 1000, content_type="image/png"),
        "/sample.jpg": lambda r: web.Response(body=b"\xff\xd8small", content_type="image/jpeg"),
        "/blocked.png": lambda r: web.Response(text="<html>hotlinking not allowed</html>", content_type="text/html"),
        "/missing.png": lambda r: web.Response(status=404),
    }


def test_build_embed():
    image = make_image(
        "7000001",
        characters=("special_week_(umamusume)", "silence_suzuka_(umamusume)"),
        artists=("some_*artist*",),
        source_url="https://example.test/art_(1)",
    )
    embed = build_embed(image, "Title", image_url="attachment://x.png")
    assert embed.title == "Title"
    assert embed.url == image.page_url
    assert "**Characters:** Special Week, Silence Suzuka" in embed.description
    assert "**Artist:** some \\*artist\\*" in embed.description
    assert "(https://example.test/art_%281%29)" in embed.description
    assert embed.image.url == "attachment://x.png"
    assert embed.footer.text == "Danbooru · post #7000001"


def test_build_embed_without_metadata():
    embed = build_embed(make_image(), "Title", image_url="https://x.test/a.png")
    assert embed.description is None


async def test_uploads_original_when_small_enough(fake_api):
    api = await fake_api(image_server_routes())
    image = make_image("5", image_url=f"{api.base_url}/original.png", sample_url=f"{api.base_url}/sample.jpg")
    post = await prepare_post(api.session, image, "T", max_bytes=1_000_000)
    assert post.filename == "umamusume_danbooru_5.png"
    assert post.data == PNG * 1000
    assert post.embed.image.url == "attachment://umamusume_danbooru_5.png"
    assert api.requests[0].headers["Referer"] == image.page_url
    # Every send gets its own discord.File.
    first, second = post.send_kwargs("hi"), post.send_kwargs()
    assert first["file"] is not second["file"]
    assert first["content"] == "hi" and "content" not in second


async def test_falls_back_to_sample_when_original_too_big(fake_api):
    api = await fake_api(image_server_routes())
    image = make_image("5", image_url=f"{api.base_url}/original.png", sample_url=f"{api.base_url}/sample.jpg")
    post = await prepare_post(api.session, image, "T", max_bytes=50_000)
    assert post.filename == "umamusume_danbooru_5.jpg"
    assert post.data == b"\xff\xd8small"


async def test_links_image_when_downloads_fail(fake_api):
    api = await fake_api(image_server_routes())
    image = make_image("5", image_url=f"{api.base_url}/blocked.png", sample_url=f"{api.base_url}/missing.png")
    post = await prepare_post(api.session, image, "T", max_bytes=1_000_000)
    assert post.data is None and post.filename is None
    assert post.embed.image.url == image.image_url
    assert "file" not in post.send_kwargs()


async def test_upload_disabled(fake_api):
    api = await fake_api(image_server_routes())
    image = make_image("5", image_url=f"{api.base_url}/original.png")
    post = await prepare_post(api.session, image, "T", upload=False, max_bytes=1_000_000)
    assert post.data is None and not api.requests
