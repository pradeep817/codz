package dev.fieldops.app.data.model

import com.squareup.moshi.Json
import com.squareup.moshi.JsonClass

@JsonClass(generateAdapter = true)
data class Job(
    val id: Int,
    val title: String,
    @Json(name = "created_at") val createdAt: String,
    val notes: String? = null,
)
